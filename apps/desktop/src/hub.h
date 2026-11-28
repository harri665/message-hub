#pragma once

#include <QHash>
#include <QJsonDocument>
#include <QNetworkAccessManager>
#include <QObject>
#include <QTimer>
#include <QUrl>
#include <QVariantMap>
#include <QWebSocket>
#include <functional>
#include <qqmlintegration.h>

#include "listmodel.h"

class QQmlEngine;
class QJSEngine;
class QNetworkReply;

// Everything that talks to the message hub: sign-in, the inbox, the open thread, sending, search, the live socket,
// attachments and desktop notifications. Lives for the whole process, so the socket and notifications keep working
// after the window is closed (the window and all of QML are freed then, see main.cpp).
class Hub : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_SINGLETON
    Q_PROPERTY(QString server READ server NOTIFY serverChanged)
    Q_PROPERTY(bool signedIn READ signedIn NOTIFY signedInChanged)
    Q_PROPERTY(bool online READ online NOTIFY onlineChanged)
    Q_PROPERTY(bool busy READ busy NOTIFY busyChanged)
    Q_PROPERTY(QString error READ error NOTIFY errorChanged)
    Q_PROPERTY(JsonListModel *threads READ threads CONSTANT)
    Q_PROPERTY(JsonListModel *messages READ messages CONSTANT)
    Q_PROPERTY(JsonListModel *results READ results CONSTANT)
    Q_PROPERTY(QString filter READ filter WRITE setFilter NOTIFY filterChanged)
    Q_PROPERTY(QString currentTid READ currentTid NOTIFY currentChanged)
    Q_PROPERTY(QVariantMap current READ current NOTIFY currentChanged)
    Q_PROPERTY(bool hasOlder READ hasOlder NOTIFY olderChanged)
    Q_PROPERTY(bool loadingOlder READ loadingOlder NOTIFY olderChanged)
    Q_PROPERTY(int unreadTotal READ unreadTotal NOTIFY unreadTotalChanged)
    Q_PROPERTY(bool showArchived READ showArchived NOTIFY archivedChanged)
    Q_PROPERTY(int archivedCount READ archivedCount NOTIFY archivedChanged)
    Q_PROPERTY(int archivedUnread READ archivedUnread NOTIFY archivedChanged)
    Q_PROPERTY(bool windowActive READ windowActive WRITE setWindowActive NOTIFY windowActiveChanged)

public:
    static Hub *instance();
    static Hub *create(QQmlEngine *, QJSEngine *);

    QString server() const { return m_server; }
    bool signedIn() const { return !m_token.isEmpty(); }
    bool online() const { return m_online; }
    bool busy() const { return m_busy; }
    QString error() const { return m_error; }
    JsonListModel *threads() { return &m_threadModel; }
    JsonListModel *messages() { return &m_messageModel; }
    JsonListModel *results() { return &m_resultModel; }
    QString filter() const { return m_filter; }
    void setFilter(const QString &f);
    QString currentTid() const { return m_tid; }
    QVariantMap current() const { return m_detail; }
    bool hasOlder() const { return m_hasOlder; }
    bool loadingOlder() const { return m_loadingOlder; }
    int unreadTotal() const { return m_unreadTotal; }
    bool showArchived() const { return m_showArchived; }
    int archivedCount() const { return m_archivedCount; }
    int archivedUnread() const { return m_archivedUnread; }
    bool windowActive() const { return m_windowActive; }
    void setWindowActive(bool a);

    Q_INVOKABLE void login(const QString &server, const QString &password);
    Q_INVOKABLE void logout();
    Q_INVOKABLE void openThread(const QString &tid);
    Q_INVOKABLE void closeThread();
    Q_INVOKABLE void loadOlder();
    Q_INVOKABLE void send(const QString &text, int conversationId, int replyToId);
    Q_INVOKABLE void retry(const QString &localKey);
    Q_INVOKABLE void pickFile(int conversationId);
    Q_INVOKABLE void sendFiles(const QList<QUrl> &files, int conversationId);
    Q_INVOKABLE void openAttachment(qint64 id, const QString &filename);
    Q_INVOKABLE void pinMessage(qint64 id, bool pin);
    // Archive or unarchive a whole chat (the hub applies it to every chat of the person, and to WhatsApp).
    Q_INVOKABLE void archiveThread(const QString &tid, bool archive);
    // Switch the sidebar between the inbox and the archived chats.
    Q_INVOKABLE void setShowArchived(bool show);
    // Bring a message into view (loading older pages if it isn't loaded yet); revealRequested() reports its row.
    Q_INVOKABLE void revealMessage(qint64 id);
    Q_INVOKABLE void copyText(const QString &text);
    Q_INVOKABLE void refresh();
    Q_INVOKABLE void openLink(const QString &url);
    Q_INVOKABLE void clearError() { setError({}); }

    // ---- for MacShell's Dynamic Island (see App::addIslandClient) ----
    // Send to any chat, open or not; the outcome comes back through sendResult().
    void sendTo(const QString &tid, const QString &text);
    void markReadNow(const QString &tid) { markRead(tid); }
    // The inbox for the island: sign-in state, connection, unread total and the most recent chats.
    QJsonObject islandState(int threads) const;
    // While the island is listening it shows new messages itself, so the app stops sending desktop notifications.
    void setIslandClients(int n) { m_islandClients = n; }

    // For the image provider: calls back on the main thread with a local file path (or an error).
    // width 0 = the original; otherwise the hub's resized copy (320, 640 or 1280 px wide).
    // A thread's profile photo (version = the hub's photo version, so a changed photo is a new cache entry).
    void fetchAvatar(const QString &tid, const QString &version, std::function<void(QString path, QString error)> done);
    void fetchAttachment(qint64 id, int width, bool retry, std::function<void(QString path, QString error)> done);

    // Called when the window goes away: drop the per-thread state so the process idles small.
    void releaseView();
    bool idle() const { return m_writes == 0; }

signals:
    void serverChanged();
    void signedInChanged();
    void onlineChanged();
    void busyChanged();
    void errorChanged();
    void filterChanged();
    void currentChanged();
    void olderChanged();
    void unreadTotalChanged();
    void archivedChanged();
    void windowActiveChanged();
    void showRequested(const QString &tid);
    void inboxChanged();
    void incoming(const QVariantMap &message);  // a new message from someone else
    void revealRequested(int row, qint64 id);
    void sendResult(const QString &tid, bool ok, const QString &error);

private:
    Hub();
    using JsonCb = std::function<void(const QJsonDocument &)>;
    using FailCb = std::function<void(int status, const QString &error)>;
    QNetworkRequest request(const QString &path) const;
    QNetworkReply *call(const QByteArray &verb, const QString &path, const QByteArray &body = {});
    void handle(QNetworkReply *reply, JsonCb ok, FailCb fail = {});
    void setError(const QString &e);
    void setBusy(bool b);
    void setToken(const QString &t);
    void signedOut();

    void loadThreads();
    void applyThreads(const QList<QVariantMap> &rows, bool save);
    void rebuildThreadModel();
    QVariantMap decorateThread(QVariantMap t) const;
    void refreshCurrent();
    void refreshDetail();
    void loadArchived();
    void tryReveal();
    void applyMessages();
    void markRead(const QString &tid);
    qint64 newestId() const;
    void moveToTop(const QString &tid, const QString &text);
    void search(const QString &q);
    void scheduleThreads(int ms);

    void connectLive();
    void onLive(const QString &text);
    void notify(const QVariantMap &preview);

    void readConfig();
    void writeConfig();
    QString cacheFile(const QString &name) const;
    void saveThreadCache(const QString &tid);

    QString m_server;
    QString m_token;
    QString m_error;
    bool m_busy = false;
    bool m_online = false;
    bool m_windowActive = false;
    int m_unreadTotal = 0;
    bool m_showArchived = false;
    int m_archivedCount = 0;
    int m_archivedUnread = 0;
    QList<QVariantMap> m_archivedThreads;  // only loaded while the archived list is showing
    QNetworkReply *m_archivedReply = nullptr;
    int m_writes = 0;  // sends still going out
    int m_islandClients = 0;

    QNetworkAccessManager m_nam;
    QWebSocket m_ws;
    QTimer m_reconnect;
    int m_backoff = 1000;
    QTimer m_threadsTimer;   // coalesces inbox refreshes
    QTimer m_messagesTimer;  // coalesces open-thread refreshes
    QTimer m_searchTimer;
    QTimer m_detailTimer;    // coalesces open-thread detail refreshes (pins)
    qint64 m_revealId = 0;
    QTimer m_clock;          // keeps "Yesterday" / weekday labels right
    QNetworkReply *m_threadsReply = nullptr;

    QList<QVariantMap> m_allThreads;
    JsonListModel m_threadModel;
    QString m_filter;
    JsonListModel m_resultModel;

    QString m_tid;
    QVariantMap m_detail;
    QList<QVariantMap> m_msgs;     // newest first, as the hub returned them
    QList<QVariantMap> m_pending;  // messages being sent, newest first
    JsonListModel m_messageModel;
    bool m_hasOlder = false;
    bool m_loadingOlder = false;
    int m_generation = 0;  // bumps when the open thread changes, so late replies are dropped

    QHash<QString, QList<std::function<void(QString, QString)>>> m_fetching;
};
