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
class Theme : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_SINGLETON
    Q_PROPERTY(bool dark READ dark NOTIFY changed)
    Q_PROPERTY(bool use24h READ use24h NOTIFY changed)
    Q_PROPERTY(QColor accent READ accent NOTIFY changed)
    Q_PROPERTY(QString font READ font NOTIFY changed)
    Q_PROPERTY(QString boldFont READ boldFont NOTIFY changed)
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
    QColor bg() const { return m_dark ? QColor("#1C1C1E") : QColor("#F2F2F7"); }
    QColor bar() const { return m_dark ? QColor("#2A2A2C") : QColor("#E8E8ED"); }
    QColor card() const { return m_dark ? QColor("#2C2C2E") : QColor("#FFFFFF"); }
    QColor text() const { return m_dark ? QColor("#F5F5F7") : QColor("#1D1D1F"); }
    QColor text2() const { return m_dark ? QColor::fromRgbF(1, 1, 1, 0.55f) : QColor::fromRgbF(0, 0, 0, 0.5f); }
    QColor text3() const { return m_dark ? QColor::fromRgbF(1, 1, 1, 0.3f) : QColor::fromRgbF(0, 0, 0, 0.28f); }
    QColor sep() const { return m_dark ? QColor::fromRgbF(1, 1, 1, 0.09f) : QColor::fromRgbF(0, 0, 0, 0.09f); }
    QColor ctrl() const { return m_dark ? QColor::fromRgbF(1, 1, 1, 0.10f) : QColor::fromRgbF(0, 0, 0, 0.06f); }
    QColor ctrlSel() const { return m_dark ? QColor("#636366") : QColor("#FFFFFF"); }
    QColor border() const { return m_dark ? QColor::fromRgbF(1, 1, 1, 0.16f) : QColor::fromRgbF(0, 0, 0, 0.2f); }
    QColor lightOff() const { return m_dark ? QColor::fromRgbF(1, 1, 1, 0.2f) : QColor::fromRgbF(0, 0, 0, 0.15f); }
    QColor bubbleIn() const { return m_dark ? QColor("#3A3A3C") : QColor("#E9E9EB"); }
    QColor sms() const { return m_dark ? QColor("#30D158") : QColor("#34C759"); }
    QColor whatsapp() const { return m_dark ? QColor("#12A58C") : QColor("#00A884"); }
    QColor danger() const { return m_dark ? QColor("#FF453A") : QColor("#FF3B30"); }

signals:
    void changed();

private:
    Theme();
    void load();
    void watch();

    QFileSystemWatcher m_watcher;
    QTimer m_debounce;
    bool m_dark = true;
    bool m_use24h = false;
    QColor m_accent{"#0A84FF"};
    QString m_font;
    QString m_boldFont;
};
