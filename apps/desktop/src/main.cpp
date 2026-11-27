#include <QDir>
#include <QFont>
#include <QGuiApplication>
#ifdef Q_OS_WIN
#include <QApplication>  // the tray icon and the file dialog are Qt Widgets
#endif
#include <QImageReader>
#include <QJsonDocument>
#include <QJSEngine>
#include <QLocalServer>
#include <QMimeDatabase>
#include <QLocalSocket>
#include <QQmlApplicationEngine>
#include <QQuickItem>
#include <QQuickItemGrabResult>
#include <QQuickWindow>
#include <QTimer>

#include "app.h"
#include "hub.h"
#include "platform.h"
#include "theme.h"
#include "updater.h"

// ---------- App ----------

App *App::instance() {
    static App *a = new App;
    return a;
}

App::App() {
    m_islandState.setSingleShot(true);
    m_islandState.setInterval(200);
    connect(&m_islandState, &QTimer::timeout, this, [this] { toIslands(Hub::instance()->islandState(6)); });
    connect(Hub::instance(), &Hub::inboxChanged, &m_islandState, qOverload<>(&QTimer::start));
    connect(Hub::instance(), &Hub::incoming, this, [this](const QVariantMap &m) {
        QJsonObject o = QJsonObject::fromVariantMap(m);
        o.insert("type", "message");
        toIslands(o);
    });
    connect(Hub::instance(), &Hub::sendResult, this, [this](const QString &tid, bool ok, const QString &error) {
        toIslands({{"type", "sent"}, {"tid", tid}, {"ok", ok}, {"error", error}});
    });
    connect(Theme::instance(), &Theme::changed, this, [this] { syncGlass(); });
    // An update finished downloading while the window is closed: install it now (the app comes back in the background).
    connect(Updater::instance(), &Updater::changed, this, [this] {
        if (Updater::instance()->ready() && !m_engine) QTimer::singleShot(1500, this, &App::restartWhenIdle);
    });
}

QQuickWindow *App::window() const {
    return m_engine ? qobject_cast<QQuickWindow *>(m_engine->rootObjects().value(0)) : nullptr;
}

// ---------- compositor glass ----------
// With glass on, the compositor draws glass behind the window (hyprglass on Hyprland, acrylic on Windows 11) and the
// QML tints it. With glass off from the start nothing is asked of the compositor, so the window is exactly as before.
void App::syncGlass(bool again) {
    Platform::instance()->setGlass(window(), Theme::instance()->glass(), Theme::instance()->dark(), again);
}

// ---------- MacShell's Dynamic Island ----------
// The island connects to the same local socket and sends "island". From then on it gets JSON lines:
//   {"type":"state", signedIn, online, unread, threads:[{tid,title,initials,time,preview,unread,service,isGroup}]}
//   {"type":"message", tid, sender, title, initials, text, service, is_group, time}   (someone wrote to me)
//   {"type":"sent", tid, ok, error}
// and can send {"cmd":"send","tid","text"}, {"cmd":"open","tid"}, {"cmd":"read","tid"}, {"cmd":"refresh"}.
void App::addIslandClient(QLocalSocket *s) {
    if (m_islands.contains(s)) return;
    m_islands << s;
    Hub::instance()->setIslandClients(int(m_islands.size()));
    connect(s, &QObject::destroyed, this, [this, s] {
        m_islands.removeAll(s);
        Hub::instance()->setIslandClients(int(m_islands.size()));
    });
    s->write(QJsonDocument(Hub::instance()->islandState(6)).toJson(QJsonDocument::Compact) + '\n');
}

void App::toIslands(const QJsonObject &message) {
    if (m_islands.isEmpty()) return;
    const QByteArray line = QJsonDocument(message).toJson(QJsonDocument::Compact) + '\n';
    for (QLocalSocket *s : std::as_const(m_islands))
        if (s->state() == QLocalSocket::ConnectedState) s->write(line);
}

void App::handleLine(QLocalSocket *from, const QString &line) {
    if (line == "quit") quit();
    else if (line == "island") addIslandClient(from);
    else if (line.startsWith("glass ")) Theme::instance()->setGlassMode(line.mid(6).trimmed());
    else if (line.startsWith("show")) showWindow(line.mid(5).trimmed());
    else if (line.startsWith("dev ") && qEnvironmentVariableIsSet("MESSAGE_HUB_DEV")) dev(line.mid(4));
    else if (line.startsWith('{')) {
        const QJsonObject o = QJsonDocument::fromJson(line.toUtf8()).object();
        const QString cmd = o.value("cmd").toString(), tid = o.value("tid").toString();
        if (cmd == "send") Hub::instance()->sendTo(tid, o.value("text").toString());
        else if (cmd == "open") showWindow(tid);
        else if (cmd == "read" && !tid.isEmpty()) Hub::instance()->markReadNow(tid);
        else if (cmd == "refresh") Hub::instance()->refresh();
    }
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
            Platform::instance()->raise(w);
        }
        return;
    }
    m_engine = new QQmlApplicationEngine(this);
    m_engine->addImageProvider("att", new AttachmentImages);
    QObject::connect(m_engine, &QQmlApplicationEngine::objectCreationFailed, qApp, [] { QCoreApplication::exit(1); },
                     Qt::QueuedConnection);
    m_engine->loadFromModule("MessageHub", "Main");
    Platform::instance()->forgetWindow();
    // The compositor knows the window once its first frame is up. The tags go out then, and once more a moment later
    // in case the compositor handled them before it had mapped the window (adding a tag twice changes nothing).
    if (QQuickWindow *w = window())
        connect(w, &QQuickWindow::frameSwapped, this, [this] {
            syncGlass();
            QTimer::singleShot(300, this, [this] { syncGlass(true); });
        }, Qt::ConnectionType(Qt::QueuedConnection | Qt::SingleShotConnection));
}

void App::closeWindow() {
    if (!m_engine) return;
    Hub::instance()->releaseView();
    if (auto *w = qobject_cast<QQuickWindow *>(m_engine->rootObjects().value(0))) w->hide();
    QQmlApplicationEngine *e = m_engine;
    m_engine = nullptr;
    QObject::connect(e, &QObject::destroyed, [] { Platform::instance()->trimMemory(); });  // hand the freed memory back
    e->deleteLater();
    QTimer::singleShot(1500, this, &App::restartWhenIdle);
}

// Once a window has been shown, the GPU driver and the Qt Quick runtime stay loaded (roughly 70 MB) even after the
// window is gone. Starting over in background mode brings the process back to its idle size (about 12 MB of its own);
// the inbox comes back from the disk cache and reopening still takes ~0.1 s. Waits for sends that are still going out.
// A downloaded update is installed at this point instead: the updater starts the new version in the background.
void App::restartWhenIdle() {
    if (m_engine || qEnvironmentVariableIsSet("MESSAGE_HUB_NO_RESTART")) return;
    if (!Hub::instance()->idle()) {
        QTimer::singleShot(1000, this, &App::restartWhenIdle);
        return;
    }
    if (Updater::instance()->ready() && Updater::instance()->applyAndExit({"--background"})) return;
    if (!Platform::instance()->restartInBackground()) Platform::instance()->trimMemory();
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
    else if (verb == "settings" && w) {
        if (auto *s = w->findChild<QObject *>("sidebar")) QMetaObject::invokeMethod(s, "openSettings");
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
    // Ask the hub for the smallest resized copy that covers the size on screen (older hubs ignore it).
    const int want = requested.width() > 0 ? requested.width() : 1280;
    const int width = want <= 320 ? 320 : want <= 640 ? 640 : 1280;
    QMetaObject::invokeMethod(Hub::instance(), [r, att, width, retry, requested, pool] {
        Hub::instance()->fetchAttachment(att, width, retry, [r, requested, pool](const QString &path, const QString &err) {
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
    Updater::startup();  // first: the installer may start the app just to run its hooks
    Platform::beforeApp();
    QQuickWindow::setDefaultAlphaBuffer(true);  // rounded window corners
#ifdef Q_OS_WIN
    QApplication app(argc, argv);
#else
    QGuiApplication app(argc, argv);
#endif
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
    // --glass on|off|auto: sets (and saves) the window glass option, here or in the running instance.
    QString glass;
    if (int i = int(args.indexOf("--glass")); i >= 0 && i + 1 < args.size()) glass = args.at(i + 1);
    if (!glass.isEmpty() && glass != "on" && glass != "off" && glass != "auto") {
        qWarning("message-hub: --glass takes on, off or auto");
        return 2;
    }

    // One instance: a second launch (Dock, Spotlight, notification) just tells the running one what to do.
    const QString socketPath = qEnvironmentVariable("MESSAGE_HUB_SOCKET", Platform::socketName());
    {
        QLocalSocket probe;
        probe.connectToServer(socketPath);
        if (probe.waitForConnected(300)) {
            if (!glass.isEmpty()) probe.write("glass " + glass.toUtf8() + '\n');
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
                while (s->canReadLine()) App::instance()->handleLine(s, QString::fromUtf8(s->readLine()).trimmed());
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

    Platform::instance()->init();
    QObject::connect(Platform::instance(), &Platform::showRequested, &app, [] { App::instance()->showWindow(); });
    QObject::connect(Platform::instance(), &Platform::quitRequested, &app, [] { App::instance()->quit(); });
    Hub::instance();
    if (!glass.isEmpty()) Theme::instance()->setGlassMode(glass);
    QObject::connect(Hub::instance(), &Hub::showRequested, &app, [](const QString &tid) { App::instance()->showWindow(tid); });
    Updater::instance();

    if (command.startsWith("show")) App::instance()->showWindow(command.mid(5).trimmed());
    return app.exec();
}
