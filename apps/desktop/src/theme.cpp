#include "theme.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QFontDatabase>
#include <QGuiApplication>
#include <QJSEngine>
#include <QJsonDocument>
#include <QJsonObject>
#include <QStyleHints>

namespace {
QString home(const QString &rel) { return QDir::homePath() + rel; }
const QString kDock = "/.config/macdock/settings.json";
const QString kBar = "/.config/macbar/settings.json";

QJsonObject readJson(const QString &path) {
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) return {};
    return QJsonDocument::fromJson(f.readAll()).object();
}

// MacShell ships Open Runde inside its config folder and loads it itself; load the same files so the app matches.
void loadMacShellFonts() {
    static bool done = false;
    if (done) return;
    done = true;
    const QString dir = home("/.config/quickshell/MacShell/assets/fonts/");
    for (const char *f : {"OpenRunde-Regular.otf", "OpenRunde-Semibold.otf"})
        if (QFileInfo::exists(dir + f)) QFontDatabase::addApplicationFont(dir + f);
}
}  // namespace

Theme *Theme::instance() {
    static Theme *t = new Theme;
    return t;
}

Theme *Theme::create(QQmlEngine *, QJSEngine *) {
    QJSEngine::setObjectOwnership(instance(), QJSEngine::CppOwnership);
    return instance();
}

Theme::Theme() {
    m_debounce.setSingleShot(true);
    m_debounce.setInterval(120);
    connect(&m_debounce, &QTimer::timeout, this, [this] { load(); watch(); });
    // MacShell rewrites its settings by replacing the file, which drops it from the watcher: watch the folders too.
    connect(&m_watcher, &QFileSystemWatcher::fileChanged, &m_debounce, qOverload<>(&QTimer::start));
    connect(&m_watcher, &QFileSystemWatcher::directoryChanged, &m_debounce, qOverload<>(&QTimer::start));
    load();
    watch();
}

void Theme::watch() {
    for (const QString &rel : {kDock, kBar}) {
        const QString p = home(rel);
        if (QFileInfo::exists(p) && !m_watcher.files().contains(p)) m_watcher.addPath(p);
        const QString d = QFileInfo(p).absolutePath();
        if (QFileInfo::exists(d) && !m_watcher.directories().contains(d)) m_watcher.addPath(d);
    }
}

void Theme::load() {
    const QJsonObject dock = readJson(home(kDock));
    const QJsonObject bar = readJson(home(kBar));
    const bool haveShell = !dock.isEmpty() || !bar.isEmpty();

    auto pick = [&](const char *key) { return dock.contains(key) ? dock.value(key) : bar.value(key); };

    bool dark = m_dark;
    if (haveShell && pick("darkMode").isBool()) dark = pick("darkMode").toBool();
    else if (!haveShell) {
        // No MacShell: follow the desktop's dark/light preference.
        dark = QGuiApplication::styleHints()->colorScheme() != Qt::ColorScheme::Light;
    }

    QColor accent(pick("accent").toString());
    if (!accent.isValid()) accent = QColor("#0A84FF");

    QString family = pick("fontFamily").toString();
    if (family.isEmpty()) family = "Open Runde";
    if (family == "Open Runde") loadMacShellFonts();
    const QStringList families = QFontDatabase::families();
    if (!families.contains(family)) family = QGuiApplication::font().family();
    // Open Runde comes as two faces: bold text uses the Semibold face rather than a synthetic bold (as MacShell does).
    QString bold = family == "Open Runde" && families.contains("Open Runde Semibold") ? "Open Runde Semibold" : family;

    const bool use24h = bar.contains("use24h") ? bar.value("use24h").toBool() : m_use24h;

    // MacShell's Liquid Glass style (its own popovers, or drawn by the compositor) and its glass tuning.
    const bool shellGlass = pick("barStyle").toString() == "liquid" || pick("compositorGlass").toBool();
    const float opacity = float(qBound(0.0, pick("glassOpacity").toDouble(0.42), 1.0));
    const float rim = float(qBound(0.0, pick("glassRim").toDouble(0.45), 1.0));

    if (dark == m_dark && accent == m_accent && family == m_font && bold == m_boldFont && use24h == m_use24h &&
        shellGlass == m_shellGlass && opacity == m_glassOpacity && rim == m_glassRim)
        return;
    m_dark = dark;
    m_accent = accent;
    m_font = family;
    m_boldFont = bold;
    m_use24h = use24h;
    m_shellGlass = shellGlass;
    m_glassOpacity = opacity;
    m_glassRim = rim;
    emit changed();
}

void Theme::setGlassMode(const QString &mode) {
    const QString m = mode == "on" || mode == "off" ? mode : QStringLiteral("auto");
    if (m == m_glassMode) return;
    m_glassMode = m;
    emit glassModeChanged();
    emit changed();
}
