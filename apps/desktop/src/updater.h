#pragma once

#include <QObject>
#include <QStringList>
#include <QTimer>
#include <memory>
#include <qqmlintegration.h>

class QQmlEngine;
class QJSEngine;

// Automatic updates for the packaged app (Velopack: the Windows installer and the Linux AppImage), the same on both.
// Releases come from the GitHub repository's releases (tags desktop-v*). The app checks a minute after it starts and
// then every six hours, downloads in the background, and applies the update the next time the window is closed (the
// app restarts in the background, already updated) or right away from the settings menu. A build from source (cmake
// --install) has no updater: enabled is false and nothing is checked.
class Updater : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_SINGLETON
    Q_PROPERTY(QString version READ version CONSTANT)
    Q_PROPERTY(bool enabled READ enabled CONSTANT)
    // "idle", "checking", "downloading", "ready", "current" (checked, nothing newer) or "error"
    Q_PROPERTY(QString state READ state NOTIFY changed)
    Q_PROPERTY(int progress READ progress NOTIFY changed)     // download progress, 0..100
    Q_PROPERTY(QString available READ available NOTIFY changed)  // the version that is ready to install

public:
    // First thing in main(), before the application object: runs the installer's hooks when Velopack starts the app
    // for them (install, uninstall, update), which may end the process.
    static void startup();
    static Updater *instance();
    static Updater *create(QQmlEngine *, QJSEngine *);
    ~Updater() override;

    QString version() const { return m_version; }
    bool enabled() const;
    QString state() const { return m_state; }
    int progress() const { return m_progress; }
    QString available() const { return m_available; }
    bool ready() const { return m_state == "ready"; }

    Q_INVOKABLE void check();
    // Install the downloaded update now and reopen the window.
    Q_INVOKABLE void restartNow();
    // Hand over to the updater and quit; it installs the update and starts the app again with restartArgs.
    // Returns false (and keeps running) if there is nothing to install or the updater could not be started.
    bool applyAndExit(const QStringList &restartArgs);

signals:
    void changed();

private:
    Updater();
    void setState(const QString &s, int progress = 0);
    struct Private;
    std::unique_ptr<Private> d;
    QString m_version;
    QString m_state = QStringLiteral("idle");
    int m_progress = 0;
    QString m_available;
    QTimer m_timer;
};
