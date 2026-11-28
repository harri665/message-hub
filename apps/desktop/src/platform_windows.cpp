// Windows: a tray icon (which also carries the notifications), the native file dialog, DWM for window glass.
#include "platform.h"

#include <QAbstractNativeEventFilter>
#include <QApplication>
#include <QFileDialog>
#include <QDir>
#include <QFileInfo>
#include <QIcon>
#include <QJSEngine>
#include <QMenu>
#include <QQuickWindow>
#include <QSettings>
#include <QSystemTrayIcon>
#include <QTimer>
#include <iterator>

#include <windows.h>
#include <windowsx.h>
#include <dwmapi.h>

namespace {
const char *kRunKey = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

// The installed app lives in <root>\current\message-hub.exe, which is replaced on every update; Velopack keeps a stub
// with the same name in <root> that always starts the current version. Prefer the stub for anything stored outside.
QString launcherPath() {
    wchar_t buf[MAX_PATH * 2];
    const DWORD n = GetModuleFileNameW(nullptr, buf, DWORD(std::size(buf)));
    const QFileInfo self(QString::fromWCharArray(buf, int(n)));
    const QFileInfo stub(self.dir().absolutePath() + "/../" + self.fileName());
    return QDir::toNativeSeparators(stub.exists() ? stub.canonicalFilePath() : self.absoluteFilePath());
}
}  // namespace

// Windows 11 shows its Snap Layouts flyout over a window's maximize button, and it finds that button by asking the window
// where a point is (WM_NCHITTEST). The window is frameless and draws its own buttons, so the answer comes from here: over
// the maximize button, say HTMAXBUTTON. The system then owns that button's pointer events, which are passed on to the QML.
class CaptionFilter : public QAbstractNativeEventFilter {
public:
    explicit CaptionFilter(Platform *p) : platform(p) {}
    HWND hwnd = nullptr;
    QRectF rect;  // the maximize button, in device independent pixels from the window's top-left
    qreal scale = 1;
    bool hover = false, down = false;

    void set(bool h, bool d) {
        if (h == hover && d == down) return;
        hover = h;
        down = d;
        emit platform->maximizeStateChanged();
    }
    bool nativeEventFilter(const QByteArray &type, void *message, qintptr *result) override {
        if (!hwnd || rect.isEmpty() || type != "windows_generic_MSG") return false;
        const MSG *m = static_cast<const MSG *>(message);
        if (m->hwnd != hwnd) return false;
        switch (m->message) {
        case WM_NCHITTEST: {
            RECT r;
            GetWindowRect(hwnd, &r);
            const QPointF p((GET_X_LPARAM(m->lParam) - r.left) / scale, (GET_Y_LPARAM(m->lParam) - r.top) / scale);
            if (!rect.contains(p)) return false;
            if (result) *result = HTMAXBUTTON;
            return true;
        }
        case WM_NCMOUSEMOVE:
            if (m->wParam != HTMAXBUTTON) { set(false, false); return false; }
            {
                TRACKMOUSEEVENT t{sizeof t, TME_LEAVE | TME_NONCLIENT, hwnd, 0};
                TrackMouseEvent(&t);
            }
            set(true, down);
            return false;  // the system itself shows the Snap Layouts flyout once the pointer rests here
        case WM_NCMOUSELEAVE:
            set(false, false);
            return false;
        case WM_NCLBUTTONDOWN:
            if (m->wParam != HTMAXBUTTON) return false;
            set(true, true);
            if (result) *result = 0;
            return true;
        case WM_NCLBUTTONUP:
            if (m->wParam != HTMAXBUTTON) return false;
            set(true, false);
            emit platform->maximizeClicked();
            if (result) *result = 0;
            return true;
        }
        return false;
    }
    Platform *platform;
};

struct Platform::Private {
    CaptionFilter *filter = nullptr;
    QSystemTrayIcon *tray = nullptr;
    QMenu *menu = nullptr;
    QString lastKey;  // the tray can only show one message at a time; a click on it opens this chat
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
    // A second launch hands over to the running instance, which then brings its window up: allow it to take the focus.
    AllowSetForegroundWindow(ASFW_ANY);
}

QString Platform::socketName() { return "message-hub-" + qEnvironmentVariable("USERNAME"); }

void Platform::setAutostart(bool on) {
    QSettings run(kRunKey, QSettings::NativeFormat);
    if (on) run.setValue("Messages", '"' + launcherPath() + "\" --background");
    else run.remove("Messages");
}

bool Platform::hasTray() const { return true; }
QString Platform::windowControls() const { return "windows"; }
bool Platform::maximizeHover() const { return d->filter && d->filter->hover; }
bool Platform::maximizeDown() const { return d->filter && d->filter->down; }

void Platform::setMaximizeButton(QQuickWindow *w, const QRectF &rect) {
    if (!w) return;
    if (!d->filter) {
        d->filter = new CaptionFilter(this);
        qApp->installNativeEventFilter(d->filter);
    }
    d->filter->hwnd = reinterpret_cast<HWND>(w->winId());
    d->filter->rect = rect;
    d->filter->scale = w->devicePixelRatio();
    // The flyout only appears for a window that can be maximized by the system.
    const LONG_PTR style = GetWindowLongPtrW(d->filter->hwnd, GWL_STYLE);
    if (!(style & WS_MAXIMIZEBOX)) SetWindowLongPtrW(d->filter->hwnd, GWL_STYLE, style | WS_MAXIMIZEBOX | WS_MINIMIZEBOX);
}

void Platform::init() {
    d->tray = new QSystemTrayIcon(QIcon(":/qt/qml/MessageHub/icon.png"), qApp);
    d->tray->setToolTip("Messages");
    d->menu = new QMenu;
    QObject::connect(d->menu->addAction("Open Messages"), &QAction::triggered, this, &Platform::showRequested);
    d->menu->addSeparator();
    QObject::connect(d->menu->addAction("Quit Messages"), &QAction::triggered, this, &Platform::quitRequested);
    d->tray->setContextMenu(d->menu);
    QObject::connect(d->tray, &QSystemTrayIcon::activated, this, [this](QSystemTrayIcon::ActivationReason r) {
        if (r == QSystemTrayIcon::Trigger || r == QSystemTrayIcon::DoubleClick) emit showRequested();
    });
    QObject::connect(d->tray, &QSystemTrayIcon::messageClicked, this, [this] {
        if (!d->lastKey.isEmpty()) emit activated(d->lastKey);
    });
    d->tray->show();
}

void Platform::notify(const QString &key, const QString &title, const QString &body) {
    if (!d->tray) return;
    d->lastKey = key;
    d->tray->showMessage(title, body, QIcon(":/qt/qml/MessageHub/icon.png"), 8000);
}

void Platform::withdraw(const QString &) {}  // Windows removes the toast itself once it has been seen

void Platform::pickFiles(const QString &title, std::function<void(const QList<QUrl> &)> done,
                         std::function<void(const QString &)>) {
    // The dialog runs its own event loop: open it after the click that asked for it has been handled.
    QTimer::singleShot(0, this, [title, done] {
        const QList<QUrl> urls = QFileDialog::getOpenFileUrls(nullptr, title);
        if (!urls.isEmpty() && done) done(urls);
    });
}

// Windows 11 draws an acrylic backdrop behind the whole window once the frame is extended over it; the QML then tints
// it exactly as it tints hyprglass on Linux. Older Windows ignores the backdrop attribute and shows the tint alone.
void Platform::setGlass(QQuickWindow *w, bool on, bool dark, bool) {
    if (!w) return;
    const HWND h = reinterpret_cast<HWND>(w->winId());
    const BOOL darkMode = dark;
    DwmSetWindowAttribute(h, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, &darkMode, sizeof darkMode);
    const MARGINS margins = on ? MARGINS{-1, -1, -1, -1} : MARGINS{0, 0, 0, 0};
    DwmExtendFrameIntoClientArea(h, &margins);
    const int backdrop = on ? 3 /* DWMSBT_TRANSIENTWINDOW (acrylic) */ : 1 /* DWMSBT_NONE */;
    DwmSetWindowAttribute(h, 38 /* DWMWA_SYSTEMBACKDROP_TYPE */, &backdrop, sizeof backdrop);
}

void Platform::forgetWindow() {}

void Platform::raise(QQuickWindow *w) {
    if (!w) return;
    const HWND h = reinterpret_cast<HWND>(w->winId());
    if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
    SetForegroundWindow(h);
}

void Platform::trimMemory() { SetProcessWorkingSetSize(GetCurrentProcess(), SIZE_T(-1), SIZE_T(-1)); }

bool Platform::restartInBackground() { return false; }
