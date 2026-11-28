// Link cards for the conversation view: asks the hub for the preview of a message's link (title, site, picture) and
// fetches its pictures into the on-disk cache. Everything goes through the hub; the app never visits the linked site.
#include "hub.h"

#include <QDir>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonObject>
#include <QNetworkReply>
#include <QRegularExpression>
#include <QSaveFile>

// The preview for a message's link (a map; QVariant so QML treats it as a plain object), or an empty map while it is still being asked for. QML calls this when a row
// appears and again after linkPreviewReady(). A result stays for the session, so scrolling back is instant.
QVariant Hub::linkPreview(qint64 messageId) {
    const auto it = m_links.constFind(messageId);
    if (it != m_links.constEnd()) return *it;
    if (messageId <= 0 || !signedIn() || m_linksAsked.contains(messageId)) return QVariantMap();
    m_linksAsked.insert(messageId);
    handle(
        call("GET", "/api/messages/" + QString::number(messageId) + "/link-preview"),
        [this, messageId](const QJsonDocument &doc) {
            const QJsonObject o = doc.object();
            QVariantMap v;
            v["state"] = o.value("state").toString();
            v["url"] = o.value("url").toString();
            v["host"] = o.value("host").toString();
            v["title"] = o.value("title").toString();
            v["siteName"] = o.value("siteName").toString();
            v["rest"] = o.value("rest").toString();
            const QJsonObject image = o.value("image").toObject();
            if (!image.isEmpty()) {
                v["imageSource"] = "image://att/link/" + QString::number(messageId) + "/image?" + QUrl(image.value("src").toString()).query();
                v["imageW"] = image.value("width").toInt();
                v["imageH"] = image.value("height").toInt();
                v["imagePath"] = image.value("src").toString();
            }
            if (!o.value("icon").toString().isEmpty()) {
                v["iconSource"] = "image://att/link/" + QString::number(messageId) + "/icon?" + QUrl(o.value("icon").toString()).query();
                v["iconPath"] = o.value("icon").toString();
            }
                    m_links.insert(messageId, v);
            emit linkPreviewReady(messageId);
        },
        [this, messageId](int, const QString &) { m_linksAsked.remove(messageId); });  // try again the next time it is shown
    return QVariantMap();
}

QString Hub::linkImagePath(qint64 messageId, const QString &kind) const {
    const auto it = m_links.constFind(messageId);
    return it == m_links.constEnd() ? QString() : it->value(kind + "Path").toString();
}

// A card picture or icon, by the hub's path (its version is in the file name, so a changed picture is a new file).
void Hub::fetchLinkImage(qint64 messageId, const QString &kind, std::function<void(QString, QString)> done) {
    const QString hubPath = linkImagePath(messageId, kind);
    if (hubPath.isEmpty()) {
        done({}, QStringLiteral("No preview picture"));
        return;
    }
    const QString name = "lk:" + QString(hubPath).replace('/', '_');
    const QString path = cacheFile("lk/" + QString(hubPath).section('/', 3).replace(QRegularExpression("[^A-Za-z0-9._-]"), "_"));
    if (QFileInfo::exists(path)) {
        done(path, {});
        return;
    }
    auto it = m_fetching.find(name);
    if (it != m_fetching.end()) {
        it->append(std::move(done));
        return;
    }
    m_fetching.insert(name, {std::move(done)});
    QNetworkReply *reply = m_nam.get(request(hubPath));
    connect(reply, &QNetworkReply::finished, this, [this, reply, path, name] {
        reply->deleteLater();
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        QString err;
        if (status == 200) {
            QDir().mkpath(QFileInfo(path).absolutePath());
            QSaveFile f(path);
            if (!f.open(QIODevice::WriteOnly) || f.write(reply->readAll()) < 0 || !f.commit()) err = QStringLiteral("Could not save the picture");
        } else {
            err = status ? QStringLiteral("No picture (%1)").arg(status) : reply->errorString();
            if (status == 401 && signedIn()) signedOut();
        }
        const auto callbacks = m_fetching.take(name);
        for (const auto &cb : callbacks) cb(err.isEmpty() ? path : QString(), err);
    });
}
