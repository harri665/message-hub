// Linux: freedesktop notifications and file portal over D-Bus, Hyprland for window glass and focus.
#include "platform.h"

#include <QCoreApplication>
#include <QDBusConnection>
#include <QDBusMessage>
#include <QDBusPendingCallWatcher>
#include <QDBusPendingReply>
#include <QDir>
#include <QFile>
#include <QHash>
#include <QJSEngine>
#include <QLocalSocket>
#include <QProcess>
#include <QQuickWindow>
#include <QRandomGenerator>
#include <QStandardPaths>
#include <malloc.h>
#include <unistd.h>

namespace {
// D-Bus signals need a receiving QObject with real slots.
class Bus : public QObject {
    Q_OBJECT
public:
    QHash<uint, QString> keyById;
    QHash<QString, uint> idByKey;
    std::function<void(const QList<QUrl> &)> picked;
    QString pickHandle;

public slots:
    void onAction(uint id, const QString &) {
        const QString key = keyById.value(id);
        if (!key.isEmpty()) emit Platform::instance()->activated(key);
    }
    void onClosed(uint id, uint) {
        const QString key = keyById.take(id);
        if (!key.isEmpty() && idByKey.value(key) == id) idByKey.remove(key);
    }
    void onPortalResponse(uint response, const QVariantMap &results) {
        auto done = std::move(picked);
        picked = nullptr;
        if (response != 0 || !done) return;
        QList<QUrl> urls;
        for (const QString &u : results.value("uris").toStringList()) urls << QUrl(u);
        done(urls);
    }
};

// MacShell's Hyprland config draws window glass (the hyprglass plugin) only behind windows tagged hyprglass_enabled.
void hyprlandRequest(const QByteArray &lua, const QByteArray &classic) {
    const QString sig = qEnvironmentVariable("HYPRLAND_INSTANCE_SIGNATURE");
    const QString runtime = QStandardPaths::writableLocation(QStandardPaths::RuntimeLocation);
    if (sig.isEmpty() || runtime.isEmpty()) return;
    auto *s = new QLocalSocket(qApp);
    const bool isLua = !lua.isEmpty();
    QObject::connect(s, &QLocalSocket::connected, s, [s, lua, classic] { s->write(lua.isEmpty() ? classic : lua); });
    QObject::connect(s, &QLocalSocket::readyRead, s, [s, isLua, classic] {
        // A Lua config (Hyprland 0.55+) answers "ok" to each dispatch; an older hyprland.conf setup rejects the Lua form.
        if (isLua && !s->readAll().contains("ok")) hyprlandRequest({}, classic);
        s->disconnectFromServer();
    });
    QObject::connect(s, &QLocalSocket::disconnected, s, &QObject::deleteLater);
    QObject::connect(s, &QLocalSocket::errorOccurred, s, &QObject::deleteLater);
    s->connectToServer(runtime + "/hypr/" + sig + "/.socket.sock");
}

void writeIfChanged(const QString &path, const QByteArray &data) {
    QFile f(path);
    if (f.open(QIODevice::ReadOnly) && f.readAll() == data) return;
    f.close();
    QDir().mkpath(path.section('/', 0, -2));
    if (f.open(QIODevice::WriteOnly | QIODevice::Truncate)) f.write(data);
}

// Run from the release AppImage: give it a launcher entry and icon (as `cmake --install` does for a source build),
// pointing at the AppImage file, which keeps its path across updates.
void integrateAppImage() {
    const QString image = qEnvironmentVariable("APPIMAGE");
    if (image.isEmpty()) return;
    const QString data = QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation);
    QFile icon(":/qt/qml/MessageHub/icon.png");
    if (icon.open(QIODevice::ReadOnly)) writeIfChanged(data + "/icons/hicolor/192x192/apps/message-hub.png", icon.readAll());
    const QByteArray exec = '"' + image.toUtf8() + '"';
    writeIfChanged(data + "/applications/message-hub.desktop",
                   "[Desktop Entry]\nType=Application\nName=Messages\nGenericName=Message Hub\n"
                   "Comment=iMessage, SMS and WhatsApp in one inbox\nExec=" + exec + "\nIcon=message-hub\nTerminal=false\n"
                   "Categories=Network;InstantMessaging;Chat;\nKeywords=imessage;sms;whatsapp;chat;texts;\n"
                   "StartupWMClass=message-hub\nSingleMainWindow=true\nActions=quit;\n\n"
                   "[Desktop Action quit]\nName=Quit Messages\nExec=" + exec + " --quit\n");
}
}  // namespace

struct Platform::Private {
    Bus bus;
    int glassTags = 0;  // what the compositor was told about the window: 0 nothing (no glass), 1 dark glass, 2 light glass
};

Platform::Platform() : d(new Private) {}

Platform *Platform::instance() {
    static Platform *p = new Platform;
    return p;
}

Platform *Platform::create(QQmlEngine *, QJSEngine *) {
    QJSEngine::setObjectOwnership(instance(), QJSEngine::CppOwnership);
    return instance();
}

void Platform::beforeApp() {
    // Qt runs a render thread and image threads; two malloc arenas instead of one per thread keeps the heap small.
    mallopt(M_ARENA_MAX, 2);
}

QString Platform::socketName() {
    const QString runtime = QStandardPaths::writableLocation(QStandardPaths::RuntimeLocation);
    return (runtime.isEmpty() ? QDir::tempPath() : runtime) + "/message-hub.sock";
}

void Platform::setAutostart(bool) {}  // started from the compositor's config (see the README)

bool Platform::hasTray() const { return false; }

void Platform::init() {
    integrateAppImage();
    auto bus = QDBusConnection::sessionBus();
    bus.connect("org.freedesktop.Notifications", "/org/freedesktop/Notifications", "org.freedesktop.Notifications",
                "ActionInvoked", &d->bus, SLOT(onAction(uint, QString)));
    bus.connect("org.freedesktop.Notifications", "/org/freedesktop/Notifications", "org.freedesktop.Notifications",
                "NotificationClosed", &d->bus, SLOT(onClosed(uint, uint)));
}

void Platform::notify(const QString &key, const QString &title, const QString &body) {
    auto msg = QDBusMessage::createMethodCall("org.freedesktop.Notifications", "/org/freedesktop/Notifications",
                                              "org.freedesktop.Notifications", "Notify");
    msg << QStringLiteral("Messages") << d->bus.idByKey.value(key, 0u) << QStringLiteral("message-hub") << title
        << body.toHtmlEscaped() << QStringList{"default", "Open"}
        << QVariantMap{{"desktop-entry", "message-hub"}, {"category", "im.received"}} << -1;
    auto *w = new QDBusPendingCallWatcher(QDBusConnection::sessionBus().asyncCall(msg), &d->bus);
    QObject::connect(w, &QDBusPendingCallWatcher::finished, &d->bus, [this, w, key] {
        w->deleteLater();
        QDBusPendingReply<uint> r = *w;
        if (r.isError()) return;
        d->bus.keyById.insert(r.value(), key);
        d->bus.idByKey.insert(key, r.value());
    });
}

void Platform::withdraw(const QString &key) {
    const uint id = d->bus.idByKey.value(key);
    if (!id) return;
    auto msg = QDBusMessage::createMethodCall("org.freedesktop.Notifications", "/org/freedesktop/Notifications",
                                              "org.freedesktop.Notifications", "CloseNotification");
    msg << id;
    QDBusConnection::sessionBus().asyncCall(msg);
}

// The desktop's file picker through the XDG portal (no Qt Widgets needed, so nothing extra is loaded).
void Platform::pickFiles(const QString &title, std::function<void(const QList<QUrl> &)> done,
                         std::function<void(const QString &)> failed) {
    auto bus = QDBusConnection::sessionBus();
    const QString token = "mh" + QString::number(QRandomGenerator::global()->generate());
    QString sender = bus.baseService().mid(1);
    sender.replace('.', '_');
    const QString handlePath = "/org/freedesktop/portal/desktop/request/" + sender + '/' + token;
    if (!d->bus.pickHandle.isEmpty())
        bus.disconnect("org.freedesktop.portal.Desktop", d->bus.pickHandle, "org.freedesktop.portal.Request", "Response",
                       &d->bus, SLOT(onPortalResponse(uint, QVariantMap)));
    d->bus.pickHandle = handlePath;
    d->bus.picked = std::move(done);
    bus.connect("org.freedesktop.portal.Desktop", handlePath, "org.freedesktop.portal.Request", "Response", &d->bus,
                SLOT(onPortalResponse(uint, QVariantMap)));
    auto msg = QDBusMessage::createMethodCall("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
                                              "org.freedesktop.portal.FileChooser", "OpenFile");
    msg << QString() << title << QVariantMap{{"handle_token", token}, {"multiple", true}, {"modal", true}};
    auto *w = new QDBusPendingCallWatcher(bus.asyncCall(msg), &d->bus);
    QObject::connect(w, &QDBusPendingCallWatcher::finished, &d->bus, [w, failed] {
        w->deleteLater();
        if (w->isError() && failed) failed(QStringLiteral("No file picker is available. Drag files into the window instead."));
    });
}

// While glass is on the app tags its own window for hyprglass, with the light or dark glass to match, and takes the
// tags off again when glass is turned off. With glass off from the start nothing is sent.
void Platform::setGlass(QQuickWindow *w, bool on, bool dark, bool again) {
    if (!w || !qEnvironmentVariableIsSet("HYPRLAND_INSTANCE_SIGNATURE")) return;
    const int tags = !on ? 0 : dark ? 1 : 2;
    if (again ? tags == 0 : tags == d->glassTags) return;
    d->glassTags = tags;
    const QByteArray pid = QByteArray::number(QCoreApplication::applicationPid());
    const QList<QByteArray> set = tags == 0 ? QList<QByteArray>{"-hyprglass_enabled", "-hyprglass_theme_dark", "-hyprglass_theme_light"}
                                : tags == 1 ? QList<QByteArray>{"+hyprglass_enabled", "-hyprglass_theme_light", "+hyprglass_theme_dark"}
                                            : QList<QByteArray>{"+hyprglass_enabled", "-hyprglass_theme_dark", "+hyprglass_theme_light"};
    QByteArray lua = "[[BATCH]]", classic = "[[BATCH]]";
    for (const QByteArray &t : set) {
        lua += "dispatch hl.dsp.window.tag({ tag = \"" + t + "\", window = \"pid:" + pid + "\" });";
        classic += "dispatch tagwindow " + t + " pid:" + pid + ";";
    }
    hyprlandRequest(lua, classic);
}

void Platform::forgetWindow() { d->glassTags = 0; }

void Platform::raise(QQuickWindow *) {
    // Wayland only lets a window take focus with an activation token; on Hyprland ask the compositor directly.
    // (The first form is for Lua configs, the second for classic hyprland.conf; hyprctl exits 0 either way, so both
    // run and the one that does not apply is a no-op.)
    if (qEnvironmentVariable("XDG_CURRENT_DESKTOP").contains("Hyprland"))
        QProcess::startDetached("sh", {"-c", "hyprctl dispatch 'hl.dsp.focus({ window = \"class:^(message-hub)$\" })' >/dev/null 2>&1; "
                                             "hyprctl dispatch focuswindow 'class:^(message-hub)$' >/dev/null 2>&1"});
}

void Platform::trimMemory() { malloc_trim(0); }

// Once a window has been shown, the GPU driver and the Qt Quick runtime stay loaded (roughly 70 MB) even after the
// window is gone. Starting over in background mode brings the process back to its idle size.
bool Platform::restartInBackground() {
    // Inside an AppImage the binary path is in the image's mount, which stays mounted while this process lives.
    const QByteArray exe = QCoreApplication::applicationFilePath().toLocal8Bit();
    char background[] = "--background";
    char *args[] = {const_cast<char *>(exe.constData()), background, nullptr};
    execv(exe.constData(), args);
    return false;  // exec failed: carry on in this process
}

#include "platform_linux.moc"
