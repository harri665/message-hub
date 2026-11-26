#pragma once

#include <QJsonObject>
#include <QList>
#include <QLocalSocket>
#include <QObject>
#include <QTimer>
#include <QPointer>
#include <QQuickAsyncImageProvider>
#include <QThreadPool>
#include <qqmlintegration.h>

class QQmlApplicationEngine;
class QQuickWindow;
class QJSEngine;

// Owns the window. Closing it frees the whole QML engine (and every decoded image) while the process stays up for
// live updates and notifications; opening it again builds a new one from the precompiled QML in a few milliseconds.
class App : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_SINGLETON

public:
    static App *instance();
    static App *create(QQmlEngine *, QJSEngine *);

    void showWindow(const QString &tid = {});
    Q_INVOKABLE void closeWindow();
    Q_INVOKABLE void quit();
    void dev(const QString &command);
    void restartWhenIdle();
    void handleLine(QLocalSocket *from, const QString &line);

private:
    App();
    void addIslandClient(QLocalSocket *s);
    void toIslands(const QJsonObject &message);
    QQuickWindow *window() const;
    void syncGlass(bool again = false);
    QPointer<QQmlApplicationEngine> m_engine;
    int m_glassTags = 0;  // what the compositor was told about this window: 0 nothing (no glass), 1 dark glass, 2 light glass
    QList<QLocalSocket *> m_islands;
    QTimer m_islandState;  // coalesces inbox changes into one state message
};

// image://att/<attachment id>: downloads once into the disk cache, then decodes on a worker thread at the size the
// view asked for, so a 12 MP photo costs a thumbnail's worth of memory.
class AttachmentImages : public QQuickAsyncImageProvider {
public:
    AttachmentImages();
    QQuickImageResponse *requestImageResponse(const QString &id, const QSize &requestedSize) override;

private:
    QThreadPool m_pool;
};
