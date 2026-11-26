#pragma once

#include <QColor>
#include <QFileSystemWatcher>
#include <QObject>
#include <QTimer>
#include <qqmlintegration.h>

class QQmlEngine;
class QJSEngine;

// MacShell's look, read from its own settings (~/.config/macdock and ~/.config/macbar settings.json) and followed live:
// dark/light mode, accent colour, UI font and 24-hour clock. The palette matches MacShell's own app windows (Clock).
//
// Glass (glassMode "auto" / "on" / "off", saved in the app's config by Hub): with glass on, the window's surfaces are
// tints over the compositor's Liquid Glass (hyprglass on Hyprland, see App::syncGlass), set from MacShell's own
// glassOpacity and glassRim: the sidebar is the glassiest, the conversation pane denser so it reads well. "auto" follows
// MacShell: on while it uses its Liquid Glass style. With glass off every colour is exactly the opaque palette.
class Theme : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_SINGLETON
    Q_PROPERTY(bool dark READ dark NOTIFY changed)
    Q_PROPERTY(bool use24h READ use24h NOTIFY changed)
    Q_PROPERTY(QColor accent READ accent NOTIFY changed)
    Q_PROPERTY(QString font READ font NOTIFY changed)
    Q_PROPERTY(QString boldFont READ boldFont NOTIFY changed)
    Q_PROPERTY(QString glassMode READ glassMode WRITE setGlassMode NOTIFY glassModeChanged)
    Q_PROPERTY(bool glass READ glass NOTIFY changed)
    Q_PROPERTY(bool shellGlass READ shellGlass NOTIFY changed)
    Q_PROPERTY(QColor base READ base NOTIFY changed)
    Q_PROPERTY(QColor bg READ bg NOTIFY changed)
    Q_PROPERTY(QColor bar READ bar NOTIFY changed)
    Q_PROPERTY(QColor card READ card NOTIFY changed)
    Q_PROPERTY(QColor text READ text NOTIFY changed)
    Q_PROPERTY(QColor text2 READ text2 NOTIFY changed)
    Q_PROPERTY(QColor text3 READ text3 NOTIFY changed)
    Q_PROPERTY(QColor sep READ sep NOTIFY changed)
    Q_PROPERTY(QColor ctrl READ ctrl NOTIFY changed)
    Q_PROPERTY(QColor ctrlSel READ ctrlSel NOTIFY changed)
    Q_PROPERTY(QColor border READ border NOTIFY changed)
    Q_PROPERTY(QColor rim READ rim NOTIFY changed)
    Q_PROPERTY(QColor lightOff READ lightOff NOTIFY changed)
    Q_PROPERTY(QColor bubbleIn READ bubbleIn NOTIFY changed)
    Q_PROPERTY(QColor sms READ sms NOTIFY changed)
    Q_PROPERTY(QColor whatsapp READ whatsapp NOTIFY changed)
    Q_PROPERTY(QColor danger READ danger NOTIFY changed)

public:
    static Theme *instance();
    static Theme *create(QQmlEngine *, QJSEngine *);

    bool dark() const { return m_dark; }
    bool use24h() const { return m_use24h; }
    QColor accent() const { return m_accent; }
    QString font() const { return m_font; }
    QString boldFont() const { return m_boldFont; }

    QString glassMode() const { return m_glassMode; }
    void setGlassMode(const QString &mode);
    bool glass() const { return m_glassMode == "on" || (m_glassMode == "auto" && m_shellGlass); }
    bool shellGlass() const { return m_shellGlass; }

    // base: the window's opaque colour. bg (conversation pane) and bar (sidebar) are tints of it while glass is on.
    QColor base() const { return m_dark ? QColor("#1C1C1E") : QColor("#F2F2F7"); }
    QColor bg() const { return glass() ? tint(base(), paneAlpha()) : base(); }
    QColor bar() const {
        if (glass()) return tint(m_dark ? QColor("#2A2A2C") : QColor("#F6F6F9"), sideAlpha());
        return m_dark ? QColor("#2A2A2C") : QColor("#E8E8ED");
    }
    QColor card() const { return m_dark ? QColor("#2C2C2E") : QColor("#FFFFFF"); }
    QColor text() const { return m_dark ? QColor("#F5F5F7") : QColor("#1D1D1F"); }
    // Secondary text is a little stronger over glass, where the background behind it varies.
    QColor text2() const {
        if (glass()) return m_dark ? QColor::fromRgbF(1, 1, 1, 0.62f) : QColor::fromRgbF(0, 0, 0, 0.58f);
        return m_dark ? QColor::fromRgbF(1, 1, 1, 0.55f) : QColor::fromRgbF(0, 0, 0, 0.5f);
    }
    QColor text3() const {
        if (glass()) return m_dark ? QColor::fromRgbF(1, 1, 1, 0.4f) : QColor::fromRgbF(0, 0, 0, 0.38f);
        return m_dark ? QColor::fromRgbF(1, 1, 1, 0.3f) : QColor::fromRgbF(0, 0, 0, 0.28f);
    }
    QColor sep() const { return m_dark ? QColor::fromRgbF(1, 1, 1, 0.09f) : QColor::fromRgbF(0, 0, 0, 0.09f); }
    QColor ctrl() const { return m_dark ? QColor::fromRgbF(1, 1, 1, 0.10f) : QColor::fromRgbF(0, 0, 0, 0.06f); }
    QColor ctrlSel() const { return m_dark ? QColor("#636366") : QColor("#FFFFFF"); }
    QColor border() const { return m_dark ? QColor::fromRgbF(1, 1, 1, 0.16f) : QColor::fromRgbF(0, 0, 0, 0.2f); }
    // The window's edge. With glass it is a light rim, as on MacShell's glass (glassRim).
    QColor rim() const {
        if (!glass()) return border();
        return m_dark ? QColor::fromRgbF(1, 1, 1, 0.08f + 0.2f * m_glassRim) : QColor::fromRgbF(1, 1, 1, 0.3f + 0.5f * m_glassRim);
    }
    QColor lightOff() const { return m_dark ? QColor::fromRgbF(1, 1, 1, 0.2f) : QColor::fromRgbF(0, 0, 0, 0.15f); }
    QColor bubbleIn() const { return m_dark ? QColor("#3A3A3C") : QColor("#E9E9EB"); }
    QColor sms() const { return m_dark ? QColor("#30D158") : QColor("#34C759"); }
    QColor whatsapp() const { return m_dark ? QColor("#12A58C") : QColor("#00A884"); }
    QColor danger() const { return m_dark ? QColor("#FF453A") : QColor("#FF3B30"); }

signals:
    void changed();
    void glassModeChanged();

private:
    Theme();
    void load();
    void watch();
    static QColor tint(QColor c, float a) { c.setAlphaF(a); return c; }
    // MacShell's glassOpacity (0..1, 0.42 by default) sets how much glass shows through. Light mode uses a denser tint
    // so dark text stays readable over a bright or busy background.
    float paneAlpha() const { return qBound(0.5f, 0.5f + 0.5f * m_glassOpacity + (m_dark ? 0.f : 0.08f), 0.96f); }
    float sideAlpha() const { return qBound(0.12f, 0.08f + 0.55f * m_glassOpacity + (m_dark ? 0.f : 0.2f), 0.9f); }

    QFileSystemWatcher m_watcher;
    QTimer m_debounce;
    bool m_dark = true;
    bool m_use24h = false;
    QColor m_accent{"#0A84FF"};
    QString m_font;
    QString m_boldFont;
    QString m_glassMode = QStringLiteral("auto");
    bool m_shellGlass = false;  // MacShell uses its Liquid Glass style
    float m_glassOpacity = 0.42f;
    float m_glassRim = 0.45f;
};
