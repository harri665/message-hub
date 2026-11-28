#pragma once

#include <QList>
#include <QObject>
#include <QUrl>
#include <functional>
#include <qqmlintegration.h>

class QQuickWindow;
class QQmlEngine;
class QJSEngine;

// Everything that differs between Linux and Windows lives behind this class, so the rest of the app (all of the QML,
// Hub, Theme, App) is the same code on both. One implementation per system: platform_linux.cpp and
// platform_windows.cpp. QML never asks which system it runs on; it asks Platform what is available.
//
//                         Linux                                   Windows
//   notifications         freedesktop D-Bus (click opens chat)    tray icon balloons / toasts (click opens chat)
//   file picker           XDG desktop portal                      native file dialog
//   window glass          Hyprland + hyprglass window tags        DWM acrylic backdrop (Windows 11 22H2+)
//   rounded corners       drawn by the app (12 px)                DWM's own (8 px, Windows 11)
//   bring to front        Hyprland focus dispatch                 SetForegroundWindow
//   idle memory           malloc_trim + restart in background     trim the working set
//   background presence   MacShell's Dynamic Island               tray icon (Open / Quit)
//   start at login        compositor config (exec-once)           Run key, set by the installer
class Platform : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_SINGLETON
    // The app keeps an icon in the system tray while it runs (Windows), so closing the window never looks like quitting.
    Q_PROPERTY(bool hasTray READ hasTray CONSTANT)
    // Corner radius of the window, so the QML draws its edge along the same curve as the system's own corners.
    Q_PROPERTY(int windowRadius READ windowRadius CONSTANT)

public:
    static Platform *instance();
    static Platform *create(QQmlEngine *, QJSEngine *);

    // Process-wide tuning that has to happen before the application object exists.
    static void beforeApp();
    // Name of the local socket a second launch uses to reach the running instance.
    static QString socketName();
    // Start or stop launching in the background at login (Windows: the per-user Run key; elsewhere nothing).
    static void setAutostart(bool on);

    // Once the application object exists: the tray icon (Windows), notification signals (Linux).
    void init();
    bool hasTray() const;
    int windowRadius() const;
    // The system offers window glass and the user lets apps use it, so the Automatic glass setting means on (Windows 11
    // with transparency effects on). Linux: false, Automatic follows MacShell there. systemGlassChanged() when it may
    // have changed.
    static bool systemGlass();

    // A desktop notification for a chat. key identifies it (the thread id): a newer one for the same key replaces
    // it, withdraw() removes it, and clicking it emits activated(key).
    void notify(const QString &key, const QString &title, const QString &body);
    void withdraw(const QString &key);

    // The system's file picker; done() gets the chosen files (not called when cancelled), failed() an error message.
    void pickFiles(const QString &title, std::function<void(const QList<QUrl> &)> done, std::function<void(const QString &)> failed);

    // A new window was just created: set up its frame (Windows 11: system rounded corners and shadow, ready for glass).
    void prepareWindow(QQuickWindow *w);
    // Compositor glass behind the window. again: a repeat shortly after the window first appears, for compositors that
    // only learn about the window late.
    void setGlass(QQuickWindow *w, bool on, bool dark, bool again = false);
    void forgetWindow();  // the window is gone: the next one starts from scratch
    // Bring the window to the front and give it focus (show(), raise() and requestActivate() are not always enough).
    void raise(QQuickWindow *w);

    // Give memory the closed window used back to the system.
    void trimMemory();
    // Start the app over in background mode (to return to its idle size). Returns false where this isn't done.
    bool restartInBackground();

signals:
    void activated(const QString &key);  // a notification was clicked
    void showRequested();                 // the tray icon was clicked
    void quitRequested();                 // Quit in the tray menu
    void systemGlassChanged();            // systemGlass() may have changed

private:
    Platform();
    struct Private;
    Private *d;
};
