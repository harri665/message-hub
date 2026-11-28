// What the in-app image viewer needs from the hub: Save As, Copy image and the original file of a photo.
#include "hub.h"

#include <QFile>
#include <QFileInfo>
#include <QGuiApplication>
#include <QClipboard>
#include <QImage>
#include <QImageReader>
#include <QMimeDatabase>

#include "platform.h"

// The file name to suggest: the attachment's own, with an extension from its type when it has none.
static QString suggestedName(qint64 id, const QString &filename, const QString &mime) {
    QString name = QFileInfo(filename).fileName();
    if (name.isEmpty()) name = QString::number(id);
    if (QFileInfo(name).suffix().isEmpty()) {
        const QString suffix = QMimeDatabase().mimeTypeForName(mime).preferredSuffix();
        if (!suffix.isEmpty()) name += '.' + suffix;
    }
    return name;
}

void Hub::saveAttachment(qint64 id, const QString &filename, const QString &mime) {
    fetchAttachment(id, 0, false, [this, id, filename, mime](const QString &path, const QString &err) {
        if (!err.isEmpty()) { setError(err); return; }
        Platform::instance()->saveFile(
            QStringLiteral("Save As"), suggestedName(id, filename, mime),
            [this, path](const QUrl &dest) {
                const QString target = dest.toLocalFile();
                if (target.isEmpty()) return;
                QFile::remove(target);  // the dialog has already asked about replacing it
                if (!QFile::copy(path, target)) setError(QStringLiteral("Could not save the file"));
            },
            [this](const QString &error) { setError(error); });
    });
}

// Puts the photo (upright, as it is shown) on the clipboard. The original is used when Qt can read it; a format it can't
// (HEIC) falls back to the hub's large converted copy.
void Hub::copyImage(qint64 id) {
    auto put = [this](const QString &path) {
        QImageReader reader(path);
        reader.setAutoTransform(true);
        const QImage image = reader.read();
        if (image.isNull()) return false;
        QGuiApplication::clipboard()->setImage(image);
        return true;
    };
    fetchAttachment(id, 0, false, [this, id, put](const QString &path, const QString &err) {
        if (err.isEmpty() && put(path)) return;
        fetchAttachment(id, 1280, false, [this, put](const QString &small, const QString &err2) {
            if (!err2.isEmpty()) { setError(err2); return; }
            if (!put(small)) setError(QStringLiteral("Could not copy the image"));
        });
    });
}

void Hub::fetchOriginal(qint64 id) {
    fetchAttachment(id, 0, false, [this, id](const QString &path, const QString &err) {
        if (err.isEmpty()) emit originalReady(id, QUrl::fromLocalFile(path));
    });
}
