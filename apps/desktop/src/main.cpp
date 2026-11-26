#include <QDir>
#include <QFont>
#include <QGuiApplication>
#include <QImageReader>
#include <QJSEngine>
#include <QLocalServer>
#include <QMimeDatabase>
#include <QLocalSocket>
#include <QProcess>
#include <QQmlApplicationEngine>
#include <QQuickItem>
#include <QQuickItemGrabResult>
#include <QQuickWindow>
#include <QStandardPaths>
#include <QTimer>
#include <malloc.h>
#include <unistd.h>

#include "app.h"
#include "hub.h"
#include "theme.h"

// ---------- App ----------

App *App::instance() {
    static App *a = new App;
    return a;
}

App *App::create(QQmlEngine *, QJSEngine *) {
    QJSEngine::setObjectOwnership(instance(), QJSEngine::CppOwnership);
    return instance();
}

void App::showWindow(const QString &tid) {
    if (!tid.isEmpty() && Hub::instance()->signedIn()) Hub::instance()->openThread(tid);
    if (m_engine) {
        if (auto *w = qobject_cast<QQuickWindow *>(m_engine->rootObjects().value(0))) {
            w->show();
            w->raise();
            w->requestActivate();
        }
        // Wayland only lets a window take focus with an activation token; on Hyprland ask the compositor directly.
        // (The first form is for Lua configs, the second for classic hyprland.conf; hyprctl exits 0 either way, so both run and the one that does not apply is a no-op.)
        if (qEnvironmentVariable("XDG_CURRENT_DESKTOP").contains("Hyprland"))
            QProcess::startDetached("sh", {"-c", "hyprctl dispatch 'hl.dsp.focus({ window = \"class:^(message-hub)$\" })' >/dev/null 2>&1; "
                                                 "hyprctl dispatch focuswindow 'class:^(message-hub)$' >/dev/null 2>&1"});
        return;
    }
    m_engine = new QQmlApplicationEngine(this);
    m_engine->addImageProvider("att", new AttachmentImages);
    QObject::connect(m_engine, &QQmlApplicationEngine::objectCreationFailed, qApp, [] { QCoreApplication::exit(1); },
                     Qt::QueuedConnection);
    m_engine->loadFromModule("MessageHub", "Main");
}

void App::closeWindow() {
    if (!m_engine) return;
    Hub::instance()->releaseView();
    if (auto *w = qobject_cast<QQuickWindow *>(m_engine->rootObjects().value(0))) w->hide();
    QQmlApplicationEngine *e = m_engine;
    m_engine = nullptr;
    QObject::connect(e, &QObject::destroyed, [] { malloc_trim(0); });  // hand the freed pages back to the system
    e->deleteLater();
    QTimer::singleShot(1500, this, &App::restartWhenIdle);
}

// Once a window has been shown, the GPU driver and the Qt Quick runtime stay loaded (roughly 70 MB) even after the
// window is gone. Starting over in background mode brings the process back to its idle size (about 12 MB of its own);
// the inbox comes back from the disk cache and reopening still takes ~0.1 s. Waits for sends that are still going out.
void App::restartWhenIdle() {
    if (m_engine || qEnvironmentVariableIsSet("MESSAGE_HUB_NO_RESTART")) return;
    if (!Hub::instance()->idle()) {
        QTimer::singleShot(1000, this, &App::restartWhenIdle);
        return;
    }
    const QByteArray exe = QCoreApplication::applicationFilePath().toLocal8Bit();
    char background[] = "--background";
    char *args[] = {const_cast<char *>(exe.constData()), background, nullptr};
    execv(exe.constData(), args);
    malloc_trim(0);  // exec failed: carry on in this process
}

// exit(), not quit(): quit() first asks the window to close, and closing only hides it.
void App::quit() { QCoreApplication::exit(0); }

// Development aid, only with MESSAGE_HUB_DEV set: `message-hub --dev "grab /tmp/x.png"` drives the running instance.
void App::dev(const QString &cmd) {
    const QString verb = cmd.section(' ', 0, 0), arg = cmd.section(' ', 1);
    auto *w = m_engine ? qobject_cast<QQuickWindow *>(m_engine->rootObjects().value(0)) : nullptr;
    if (verb == "grab" && w) {
        if (auto res = w->contentItem()->grabToImage())
            QObject::connect(res.data(), &QQuickItemGrabResult::ready, res.data(), [res, arg] { res->saveToFile(arg); });
    }
    else if (verb == "send") Hub::instance()->send(arg, 0, 0);
    else if (verb == "filter") Hub::instance()->setFilter(arg);
    else if (verb == "older") Hub::instance()->loadOlder();
    else if (verb == "close") closeWindow();
    else if (verb == "login") Hub::instance()->login(arg.section(' ', 0, 0), arg.section(' ', 1));
    else if (verb == "logout") Hub::instance()->logout();
    else if (verb == "top" && w) {
        if (auto *l = w->findChild<QObject *>("messageList")) QMetaObject::invokeMethod(l, "positionViewAtEnd");
    } else if (verb == "list" && w) {
        if (auto *l = w->findChild<QObject *>("messageList"))
            qWarning("list: contentY=%.0f originY=%.0f contentHeight=%.0f height=%.0f count=%d atYEnd=%d", l->property("contentY").toDouble(),
                     l->property("originY").toDouble(), l->property("contentHeight").toDouble(), l->property("height").toDouble(),
                     l->property("count").toInt(), l->property("atYEnd").toBool());
    }
    else if (verb == "resize" && w) w->resize(arg.section('x', 0, 0).toInt(), arg.section('x', 1).toInt());
}

// ---------- attachment images ----------

namespace {
class AttachmentResponse : public QQuickImageResponse {
public:
    QQuickTextureFactory *textureFactory() const override { return QQuickTextureFactory::textureFactoryForImage(image); }
    QString errorString() const override { return error; }
    void done() { emit finished(); }
    QImage image;
    QString error;
};
}  // namespace

AttachmentImages::AttachmentImages() { m_pool.setMaxThreadCount(2); }

QQuickImageResponse *AttachmentImages::requestImageResponse(const QString &id, const QSize &requested) {
    auto *r = new AttachmentResponse;  // the engine keeps it alive until finished() (also when cancelled)
    const qint64 att = id.section('?', 0, 0).toLongLong();
    const bool retry = id.contains("retry=");
    QThreadPool *pool = &m_pool;
    QMetaObject::invokeMethod(Hub::instance(), [r, att, retry, requested, pool] {
        Hub::instance()->fetchAttachment(att, retry, [r, requested, pool](const QString &path, const QString &err) {
            if (!err.isEmpty()) {
                r->error = err;
                r->done();
                return;
            }
            pool->start([r, path, requested] {
                QImageReader reader(path);
                // Cached files have no extension: name the format from the content, so Qt doesn't try every plugin.
                static const QMimeDatabase mimes;
                const QList<QByteArray> formats = QImageReader::imageFormatsForMimeType(mimes.mimeTypeForFile(path, QMimeDatabase::MatchContent).name().toLatin1());
                if (!formats.isEmpty()) reader.setFormat(formats.first());
                reader.setAutoTransform(true);
                QSize size = reader.size();
                if (size.isValid() && requested.isValid() && (requested.width() > 0 || requested.height() > 0)) {
                    QSize box(requested.width() > 0 ? requested.width() : INT_MAX, requested.height() > 0 ? requested.height() : INT_MAX);
                    if (reader.transformation() & QImageIOHandler::TransformationRotate90) size.transpose();
                    if (size.width() > box.width() || size.height() > box.height()) {
                        QSize scaled = size.scaled(box, Qt::KeepAspectRatio);
                        if (reader.transformation() & QImageIOHandler::TransformationRotate90) scaled.transpose();
                        reader.setScaledSize(scaled);
                    }
                }
                r->image = reader.read();
                if (r->image.isNull()) r->error = reader.errorString();
                r->done();
            });
        });
    }, Qt::QueuedConnection);
    return r;
}

// ---------- main ----------

int main(int argc, char *argv[]) {
    // Qt runs a render thread and image threads; two malloc arenas instead of one per thread keeps the heap small.
    mallopt(M_ARENA_MAX, 2);
    QQuickWindow::setDefaultAlphaBuffer(true);  // rounded window corners
    QGuiApplication app(argc, argv);
    QGuiApplication::setApplicationName("message-hub");
    QGuiApplication::setApplicationDisplayName("Messages");
    QGuiApplication::setDesktopFileName("message-hub");
    QGuiApplication::setQuitOnLastWindowClosed(false);
    QImageReader::setAllocationLimit(256);

    const QStringList args = app.arguments().mid(1);
    QString command = "show";
    if (args.contains("--background")) command = "background";
    if (args.contains("--quit")) command = "quit";
    if (int i = int(args.indexOf("--open")); i >= 0 && i + 1 < args.size()) command = "show " + args.at(i + 1);
    if (int i = int(args.indexOf("--dev")); i >= 0 && i + 1 < args.size()) command = "dev " + args.at(i + 1);

    // One instance: a second launch (Dock, Spotlight, notification) just tells the running one what to do.
    const QString runtime = QStandardPaths::writableLocation(QStandardPaths::RuntimeLocation);
    const QString socketPath = qEnvironmentVariable("MESSAGE_HUB_SOCKET", (runtime.isEmpty() ? QDir::tempPath() : runtime) + "/message-hub.sock");
    {
        QLocalSocket probe;
        probe.connectToServer(socketPath);
        if (probe.waitForConnected(300)) {
            probe.write(command.toUtf8() + '\n');
            probe.waitForBytesWritten(300);
            return 0;
        }
    }
    if (command == "quit" || command.startsWith("dev ")) return 0;  // nothing running to talk to
    QLocalServer::removeServer(socketPath);
    QLocalServer server;
    server.setSocketOptions(QLocalServer::UserAccessOption);
    if (!server.listen(socketPath)) qWarning("message-hub: cannot listen on %s: %s", qPrintable(socketPath), qPrintable(server.errorString()));
    QObject::connect(&server, &QLocalServer::newConnection, &app, [&server] {
        while (QLocalSocket *s = server.nextPendingConnection()) {
            QObject::connect(s, &QLocalSocket::readyRead, s, [s] {
                while (s->canReadLine()) {
                    const QString line = QString::fromUtf8(s->readLine()).trimmed();
                    if (line == "quit") App::instance()->quit();
                    else if (line.startsWith("show")) App::instance()->showWindow(line.mid(5).trimmed());
                    else if (line.startsWith("dev ") && qEnvironmentVariableIsSet("MESSAGE_HUB_DEV")) App::instance()->dev(line.mid(4));
                }
            });
            QObject::connect(s, &QLocalSocket::disconnected, s, &QObject::deleteLater);
        }
    });

    auto applyFont = [] {
        QFont f(Theme::instance()->font());
        f.setPixelSize(13);
        QGuiApplication::setFont(f);
    };
    applyFont();
    QObject::connect(Theme::instance(), &Theme::changed, &app, applyFont);

    Hub::instance();
    QObject::connect(Hub::instance(), &Hub::showRequested, &app, [](const QString &tid) { App::instance()->showWindow(tid); });

    if (command.startsWith("show")) App::instance()->showWindow(command.mid(5).trimmed());
    return app.exec();
}
