#include "hub.h"

#include <QClipboard>
#include <QDateTime>
#include <QDesktopServices>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QGuiApplication>
#include <QHttpMultiPart>
#include <QJSEngine>
#include <QJsonArray>
#include <QJsonObject>
#include <QLocale>
#include <QMimeDatabase>
#include <QNetworkCookie>
#include <QNetworkReply>
#include <QRegularExpression>
#include <QSaveFile>
#include <QSet>
#include <QStandardPaths>
#include <QStyleHints>
#include <QUrlQuery>

#include "platform.h"
#include "searchassist.h"
#include "theme.h"

namespace {
constexpr int kPage = 60;

// MESSAGE_HUB_PROFILE=<dir> keeps a test instance's session and cache apart from the real one (on every system;
// Windows has no XDG_CONFIG_HOME / XDG_CACHE_HOME to do it with).
QString profileDir(const char *sub) {
    const QString p = qEnvironmentVariable("MESSAGE_HUB_PROFILE");
    return p.isEmpty() ? QString() : QDir(p).filePath(QString::fromLatin1(sub));
}
QString configDir() {
    const QString p = profileDir("config");
    return p.isEmpty() ? QStandardPaths::writableLocation(QStandardPaths::AppConfigLocation) : p;
}
QString cacheDir() {
    const QString p = profileDir("cache");
    return p.isEmpty() ? QStandardPaths::writableLocation(QStandardPaths::CacheLocation) : p;
}

QDateTime parseTime(const QVariant &v) {
    QDateTime d = QDateTime::fromString(v.toString(), Qt::ISODateWithMs);
    return d.isValid() ? d.toLocalTime() : QDateTime();
}
QString isoNow() { return QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs); }

QString clockText(const QDateTime &d) {
    return QLocale().toString(d.time(), Theme::instance()->use24h() ? QStringLiteral("HH:mm") : QStringLiteral("h:mm AP"));
}

qint64 daysAgo(const QDateTime &d) { return d.date().daysTo(QDate::currentDate()); }

// Inbox time: clock today, "Yesterday", weekday this week, otherwise a short date.
QString listTime(const QDateTime &d) {
    if (!d.isValid()) return {};
    const qint64 days = daysAgo(d);
    if (days <= 0) return clockText(d);
    if (days == 1) return QStringLiteral("Yesterday");
    if (days < 7) return QLocale().dayName(d.date().dayOfWeek(), QLocale::LongFormat);
    if (d.date().year() == QDate::currentDate().year()) return QLocale().toString(d.date(), QStringLiteral("MMM d"));
    return QLocale().toString(d.date(), QLocale::ShortFormat);
}

// Separator between messages, like Messages.app: "Today 21:04", "Yesterday 09:12", "Tuesday 18:40", "Mon, Nov 3 at 10:15".
QString separatorText(const QDateTime &d) {
    const qint64 days = daysAgo(d);
    QString day;
    if (days <= 0) day = QStringLiteral("Today");
    else if (days == 1) day = QStringLiteral("Yesterday");
    else if (days < 7) day = QLocale().dayName(d.date().dayOfWeek(), QLocale::LongFormat);
    else if (d.date().year() == QDate::currentDate().year()) day = QLocale().toString(d.date(), QStringLiteral("ddd, MMM d 'at'"));
    else day = QLocale().toString(d.date(), QStringLiteral("ddd, MMM d, yyyy 'at'"));
    return day + ' ' + clockText(d);
}

QString initialsOf(const QString &name) {
    QStringList parts;
    for (const QString &p : name.split(' ', Qt::SkipEmptyParts)) {
        QString letters;
        for (QChar c : p) if (c.isLetterOrNumber()) letters += c;
        if (!letters.isEmpty()) parts << letters;
    }
    if (parts.isEmpty() || !parts.first().at(0).isLetter()) return QStringLiteral("#");
    QString s = parts.first().left(1);
    if (parts.size() > 1 && parts.last().at(0).isLetter()) s += parts.last().left(1);
    return s.toUpper();
}

// Escaped text with clickable links and line breaks, for Text.StyledText.
QString richText(const QString &body) {
    static const QRegularExpression url(QStringLiteral(R"((https?://|www\.)[^\s<>"]+[^\s<>".,;:!?)\]'])"));
    QString out;
    qsizetype last = 0;
    auto it = url.globalMatch(body);
    while (it.hasNext()) {
        const auto m = it.next();
        out += body.mid(last, m.capturedStart() - last).toHtmlEscaped();
        const QString link = m.captured(0);
        const QString href = link.startsWith(QStringLiteral("www.")) ? "https://" + link : link;
        out += QStringLiteral("<a href=\"%1\">%2</a>").arg(href.toHtmlEscaped(), link.toHtmlEscaped());
        last = m.capturedEnd();
    }
    out += body.mid(last).toHtmlEscaped();
    out.replace('\n', QStringLiteral("<br>"));
    return out;
}

// 1 to 3 emoji and nothing else: shown large, without a bubble.
bool jumboEmoji(const QString &body) {
    if (body.isEmpty() || body.size() > 32) return false;
    int count = 0;
    for (char32_t c : body.toUcs4()) {
        if (c == 0x200D || c == 0xFE0F || (c >= 0x1F3FB && c <= 0x1F3FF) || (c >= 0xE0020 && c <= 0xE007F)) continue;
        if (c == ' ') continue;
        const bool emoji = (c >= 0x1F000 && c <= 0x1FAFF) || (c >= 0x2600 && c <= 0x27BF) || (c >= 0x2300 && c <= 0x23FF) ||
                           c == 0x2764 || c == 0x00A9 || c == 0x00AE || (c >= 0x2B00 && c <= 0x2BFF);
        if (!emoji) return false;
        ++count;
    }
    return count >= 1 && count <= 3;
}

QList<QVariantMap> toRows(const QJsonDocument &doc) {
    QList<QVariantMap> rows;
    const QJsonArray a = doc.array();
    rows.reserve(a.size());
    for (const auto &v : a) rows << v.toObject().toVariantMap();
    return rows;
}

QString oneLine(QString s, int max = 140) {
    s.replace('\n', ' ');
    s = s.simplified();
    return s.size() > max ? s.left(max) + QChar(0x2026) : s;
}
}  // namespace

Hub *Hub::instance() {
    static Hub *h = new Hub;
    return h;
}

Hub *Hub::create(QQmlEngine *, QJSEngine *) {
    QJSEngine::setObjectOwnership(instance(), QJSEngine::CppOwnership);
    return instance();
}

Hub::Hub()
    : m_threadModel({"tid", "title", "initials", "photo", "time", "preview", "unread", "service", "isGroup", "muted"}, "tid"),
      m_resultModel({"key", "tid", "title", "initials", "photo", "time", "preview", "unread", "service", "isGroup", "muted"}, "key"),
      m_messageModel({"key", "id", "fromMe", "kind", "html", "body", "jumbo", "time", "service", "senderName", "showName",
                      "separator", "tail", "statusText", "failed", "pending", "attachments", "reactions", "replyName",
                      "replyBody", "unsent", "edited", "pinned"},
                     "key") {
    m_nam.setTransferTimeout(60000);
    m_nam.setAutoDeleteReplies(false);

    m_threadsTimer.setSingleShot(true);
    connect(&m_threadsTimer, &QTimer::timeout, this, &Hub::loadThreads);
    m_messagesTimer.setSingleShot(true);
    m_messagesTimer.setInterval(150);
    connect(&m_messagesTimer, &QTimer::timeout, this, &Hub::refreshCurrent);
    m_detailTimer.setSingleShot(true);
    m_detailTimer.setInterval(150);
    connect(&m_detailTimer, &QTimer::timeout, this, &Hub::refreshDetail);
    m_searchTimer.setSingleShot(true);
    m_searchTimer.setInterval(250);
    connect(&m_searchTimer, &QTimer::timeout, this, [this] { search(m_filter); });
    m_reconnect.setSingleShot(true);
    connect(&m_reconnect, &QTimer::timeout, this, &Hub::connectLive);
    m_clock.setInterval(60000);
    connect(&m_clock, &QTimer::timeout, this, [this] {
        for (auto &t : m_allThreads) t = decorateThread(t);
        rebuildThreadModel();
    });
    m_clock.start();
    connect(Theme::instance(), &Theme::changed, this, [this] {
        for (auto &t : m_allThreads) t = decorateThread(t);
        rebuildThreadModel();
        applyMessages();
    });

    connect(&m_ws, &QWebSocket::connected, this, [this] {
        m_backoff = 1000;
        m_online = true;
        emit onlineChanged();
        // Catch up on anything missed while disconnected.
        scheduleThreads(0);
        if (!m_tid.isEmpty()) m_messagesTimer.start();
    });
    connect(&m_ws, &QWebSocket::disconnected, this, [this] {
        if (m_online) {
            m_online = false;
            emit onlineChanged();
        }
        if (m_ws.closeCode() == 4401) {
            signedOut();
            return;
        }
        if (signedIn()) {
            m_reconnect.start(m_backoff);
            m_backoff = qMin(m_backoff * 2, 30000);
        }
    });
    connect(&m_ws, &QWebSocket::textMessageReceived, this, &Hub::onLive);

    connect(Platform::instance(), &Platform::activated, this, &Hub::showRequested);  // a notification was clicked

    connect(this, &Hub::onlineChanged, this, &Hub::inboxChanged);
    connect(this, &Hub::signedInChanged, this, &Hub::inboxChanged);

    readConfig();
    // The glass setting is saved with the rest of the config (after reading it, so reading doesn't write it back).
    connect(Theme::instance(), &Theme::glassModeChanged, this, &Hub::writeConfig);

    // Show the last inbox at once; the hub's answer replaces it when it arrives.
    QFile f(cacheFile("threads.json"));
    if (signedIn() && f.open(QIODevice::ReadOnly)) applyThreads(toRows(QJsonDocument::fromJson(f.readAll())), false);
    if (signedIn()) {
        loadThreads();
        connectLive();
    }
}

// ---------- config ----------

void Hub::readConfig() {
    QFile f(configDir() + "/config.json");
    if (!f.open(QIODevice::ReadOnly)) return;
    const QJsonObject o = QJsonDocument::fromJson(f.readAll()).object();
    m_server = o.value("server").toString();
    m_token = o.value("session").toString();
    Theme::instance()->setGlassMode(o.value("glass").toString("auto"));
}

void Hub::writeConfig() {
    QDir().mkpath(configDir());
    QSaveFile f(configDir() + "/config.json");
    if (!f.open(QIODevice::WriteOnly)) return;
    f.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner);  // holds the session token
    QJsonObject o{{"server", m_server}};
    if (!m_token.isEmpty()) o.insert("session", m_token);
    if (Theme::instance()->glassMode() != "auto") o.insert("glass", Theme::instance()->glassMode());
    f.write(QJsonDocument(o).toJson());
    f.commit();
}

QString Hub::cacheFile(const QString &name) const {
    // One cache per server, so switching servers never mixes inboxes.
    const QString dir = cacheDir() + '/' + QString::number(qHash(m_server), 16);
    return dir + '/' + name;
}

// ---------- network ----------

QNetworkRequest Hub::request(const QString &path) const {
    QNetworkRequest r(QUrl(m_server + path));
    if (!m_token.isEmpty()) r.setRawHeader("Cookie", "mh_session=" + m_token.toUtf8());
    r.setHeader(QNetworkRequest::UserAgentHeader, "MessageHubDesktop/1.0");
    r.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::NoLessSafeRedirectPolicy);
    return r;
}

QNetworkReply *Hub::call(const QByteArray &verb, const QString &path, const QByteArray &body) {
    QNetworkRequest r = request(path);
    if (verb == "GET") return m_nam.get(r);
    r.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    return m_nam.sendCustomRequest(r, verb, body.isEmpty() ? QByteArray("{}") : body);
}

void Hub::handle(QNetworkReply *reply, JsonCb ok, FailCb fail) {
    connect(reply, &QNetworkReply::finished, this, [this, reply, ok = std::move(ok), fail = std::move(fail)] {
        reply->deleteLater();
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const QByteArray data = reply->readAll();
        const QJsonDocument doc = QJsonDocument::fromJson(data);
        if (status >= 200 && status < 300) {
            if (ok) ok(doc);
            return;
        }
        if (status == 401 && signedIn()) signedOut();
        QString err = doc.object().value("error").toString();
        if (err.isEmpty()) {
            if (status) err = QStringLiteral("The hub answered %1").arg(status);
            else if (reply->error() == QNetworkReply::OperationCanceledError) err = QStringLiteral("The hub did not answer in time");
            else err = reply->errorString();
        }
        if (fail) fail(status, err);
    });
}

void Hub::setError(const QString &e) {
    if (e == m_error) return;
    m_error = e;
    emit errorChanged();
}

void Hub::setBusy(bool b) {
    if (b == m_busy) return;
    m_busy = b;
    emit busyChanged();
}

void Hub::setToken(const QString &t) {
    const bool was = signedIn();
    m_token = t;
    writeConfig();
    if (was != signedIn()) emit signedInChanged();
}

// ---------- sign in ----------

void Hub::login(const QString &serverIn, const QString &password) {
    QString server = serverIn.trimmed();
    while (server.endsWith('/')) server.chop(1);
    if (!server.isEmpty() && !server.contains(QStringLiteral("://"))) server.prepend(QStringLiteral("https://"));
    const QUrl url(server);
    if (!url.isValid() || url.host().isEmpty()) {
        setError(QStringLiteral("Enter the address of your message hub"));
        return;
    }
    if (server != m_server) {
        m_server = server;
        emit serverChanged();
    }
    setError({});
    setBusy(true);
    m_token.clear();
    QNetworkReply *reply = call("POST", "/api/auth/login", QJsonDocument(QJsonObject{{"password", password}}).toJson());
    connect(reply, &QNetworkReply::finished, this, [this, reply] {
        reply->deleteLater();
        setBusy(false);
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        if (status != 200) {
            QString err = QJsonDocument::fromJson(reply->readAll()).object().value("error").toString();
            if (err.isEmpty())
                err = status ? QStringLiteral("Sign-in failed (the hub answered %1)").arg(status)
                             : QStringLiteral("Could not reach %1. %2").arg(QUrl(m_server).host(), reply->errorString());
            setError(err);
            return;
        }
        const auto cookies = reply->header(QNetworkRequest::SetCookieHeader).value<QList<QNetworkCookie>>();
        for (const auto &c : cookies) {
            if (c.name() != "mh_session") continue;
            setToken(QString::fromUtf8(c.value()));
            loadThreads();
            connectLive();
            return;
        }
        setError(QStringLiteral("The hub did not start a session"));
    });
}

void Hub::logout() {
    if (signedIn()) handle(call("POST", "/api/auth/logout"), {});
    signedOut();
}

void Hub::signedOut() {
    m_ws.abort();
    m_reconnect.stop();
    closeThread();
    m_allThreads.clear();
    m_archivedThreads.clear();
    m_showArchived = false;
    m_archivedCount = m_archivedUnread = 0;
    emit archivedChanged();
    rebuildThreadModel();
    QDir(cacheFile({})).removeRecursively();  // cached messages belong to the session
    setToken({});
}

// ---------- inbox ----------

void Hub::scheduleThreads(int ms) {
    if (!m_threadsTimer.isActive() || m_threadsTimer.remainingTime() > ms) m_threadsTimer.start(ms);
}

void Hub::refresh() {
    scheduleThreads(0);
    if (!m_tid.isEmpty()) m_messagesTimer.start();
    if (!m_online && signedIn()) connectLive();
}

void Hub::loadThreads() {
    if (!signedIn()) return;
    if (m_threadsReply) {  // one at a time: the hub's inbox query is the slowest thing it does
        scheduleThreads(1000);
        return;
    }
    m_threadsReply = call("GET", "/api/threads?limit=300");
    handle(m_threadsReply, [this](const QJsonDocument &doc) {
        m_threadsReply = nullptr;
        applyThreads(toRows(doc), true);
    }, [this](int, const QString &) { m_threadsReply = nullptr; });
    loadArchived();
}

// The Archived row's numbers, and (while that list is showing) the archived chats themselves.
void Hub::loadArchived() {
    const int gen = m_generation;
    handle(call("GET", "/api/threads/archived-summary"), [this, gen](const QJsonDocument &doc) {
        if (gen != m_generation) return;
        const auto o = doc.object();
        const int n = o.value("archivedCount").toInt(), u = o.value("archivedUnread").toInt();
        if (n == m_archivedCount && u == m_archivedUnread) return;
        m_archivedCount = n;
        m_archivedUnread = u;
        emit archivedChanged();
        if (m_showArchived && n == 0) setShowArchived(false);
    });
    if (!m_showArchived || m_archivedReply) return;
    m_archivedReply = call("GET", "/api/threads?limit=300&archived=1");
    handle(m_archivedReply, [this, gen](const QJsonDocument &doc) {
        m_archivedReply = nullptr;
        if (gen != m_generation) return;
        m_archivedThreads.clear();
        for (const auto &r : toRows(doc)) m_archivedThreads << decorateThread(r);
        rebuildThreadModel();
    }, [this](int, const QString &) { m_archivedReply = nullptr; });
}

void Hub::setShowArchived(bool show) {
    if (show == m_showArchived) return;
    m_showArchived = show;
    m_archivedThreads.clear();
    emit archivedChanged();
    rebuildThreadModel();
    if (show) loadArchived();
}

void Hub::archiveThread(const QString &tid, bool archive) {
    // Move it between the lists at once; the hub's answer settles the real state.
    auto &from = m_showArchived ? m_archivedThreads : m_allThreads;
    for (int i = 0; i < from.size(); ++i)
        if (from.at(i).value("tid") == tid) { from.removeAt(i); break; }
    m_archivedCount += archive ? 1 : -1;
    if (m_archivedCount < 0) m_archivedCount = 0;
    emit archivedChanged();
    rebuildThreadModel();
    const QString path = QStringLiteral("/api/threads/%1/%2").arg(tid, archive ? "archive" : "unarchive");
    handle(call("POST", path, "{}"), [this](const QJsonDocument &) { scheduleThreads(0); },
           [this](int, const QString &e) { setError(e); scheduleThreads(0); });
}

QVariantMap Hub::decorateThread(QVariantMap t) const {
    const QString title = t.value("title").toString();
    t["initials"] = initialsOf(title);
    t["photo"] = t.value("avatar").toString();  // version of the profile photo; empty when there is none
    t["time"] = listTime(parseTime(t.value("last_at")));
    t["isGroup"] = t.value("is_group").toBool();
    t["muted"] = t.value("muted").toBool();  // muted on the phone: no notifications
    t["service"] = t.value("last_service").toString().isEmpty() ? QStringLiteral("imessage") : t.value("last_service").toString();

    QString preview;
    if (t.value("last_unsent").toBool()) preview = QStringLiteral("This message was unsent");
    else {
        preview = oneLine(t.value("last_body").toString().remove(QChar(0xFFFC)));
        if (preview.isEmpty() && t.value("last_has_attachment").toBool()) preview = QStringLiteral("Attachment");
    }
    if (t.value("is_group").toBool() && !preview.isEmpty()) {
        const QString who = t.value("last_from_me").toBool() ? QStringLiteral("You")
                                                             : t.value("last_sender_name").toString().section(' ', 0, 0);
        if (!who.isEmpty()) preview = who + QStringLiteral(": ") + preview;
    }
    t["preview"] = preview;
    return t;
}

void Hub::applyThreads(const QList<QVariantMap> &rows, bool save) {
    m_allThreads.clear();
    m_allThreads.reserve(rows.size());
    for (const auto &r : rows) {
        QVariantMap t = decorateThread(r);
        // The open thread is being read right now.
        if (t.value("tid") == m_tid && m_windowActive) t["unread"] = 0;
        m_allThreads << t;
    }
    rebuildThreadModel();
    if (save) {
        QDir().mkpath(QFileInfo(cacheFile("threads.json")).absolutePath());
        QSaveFile f(cacheFile("threads.json"));
        if (f.open(QIODevice::WriteOnly)) {
            QJsonArray a;
            for (const auto &t : std::as_const(m_allThreads)) a << QJsonObject::fromVariantMap(t);
            f.write(QJsonDocument(a).toJson(QJsonDocument::Compact));
            f.commit();
        }
    }
    // Keep the open thread's title in step with renamed contacts.
    if (!m_tid.isEmpty() && m_detail.value("title").toString().isEmpty()) {
        for (const auto &t : std::as_const(m_allThreads))
            if (t.value("tid") == m_tid) { m_detail["title"] = t.value("title"); emit currentChanged(); break; }
    }
}

void Hub::rebuildThreadModel() {
    emit inboxChanged();
    {  // The search box suggests these names after "from:" and "in:".
        QList<SearchAssist::Person> people;
        people.reserve(m_allThreads.size());
        for (const auto &t : std::as_const(m_allThreads)) people << SearchAssist::Person{t.value("title").toString(), t.value("is_group").toBool()};
        SearchAssist::instance()->setPeople(people);
    }
    int unread = 0;
    for (const auto &t : std::as_const(m_allThreads))
        if (!t.value("muted").toBool()) unread += t.value("unread").toInt();  // muted chats don't add to the count
    if (unread != m_unreadTotal) {
        m_unreadTotal = unread;
        emit unreadTotalChanged();
    }
    const auto &source = m_showArchived ? m_archivedThreads : m_allThreads;
    if (m_filter.trimmed().isEmpty()) {
        m_threadModel.setRows(source);
        return;
    }
    // "from: mom pizza" narrows the people list by "pizza" only, and by nothing but the words when there are none.
    bool hadFilters = false;
    const QString f = SearchAssist::freeText(m_filter, &hadFilters);
    QList<QVariantMap> rows;
    if (!hadFilters || !f.isEmpty())
        for (const auto &t : std::as_const(source))
            if (t.value("title").toString().contains(f, Qt::CaseInsensitive)) rows << t;
    m_threadModel.setRows(rows);
}

void Hub::setFilter(const QString &f) {
    if (f == m_filter) return;
    m_filter = f;
    emit filterChanged();
    rebuildThreadModel();
    if (f.trimmed().size() >= 2) m_searchTimer.start();
    else {
        m_searchTimer.stop();
        m_resultModel.setRows({});
    }
}

void Hub::search(const QString &q) {
    const QString query = q.trimmed();
    if (query.size() < 2) return;
    QUrlQuery qs;
    qs.addQueryItem("q", query);
    handle(call("GET", "/api/search?" + qs.toString(QUrl::FullyEncoded)), [this, query](const QJsonDocument &doc) {
        if (m_filter.trimmed() != query) return;  // a newer search is on its way
        QList<QVariantMap> rows;
        for (const auto &m : toRows(doc)) {
            QString who = m.value("from_me").toBool() ? QStringLiteral("You") : m.value("sender_name").toString();
            rows << QVariantMap{{"key", "r" + m.value("id").toString()},
                                {"tid", m.value("tid")},
                                {"title", m.value("thread_title").toString().isEmpty() ? who : m.value("thread_title")},
                                {"initials", QString()}, {"photo", QString()}, {"unread", 0}, {"service", QString()}, {"isGroup", false}, {"muted", false},
                                {"time", listTime(parseTime(m.value("sent_at")))},
                                {"preview", (who.isEmpty() ? QString() : who.section(' ', 0, 0) + ": ") + oneLine(m.value("body").toString())}};
        }
        m_resultModel.setRows(rows);
    });
}

// ---------- the open thread ----------

void Hub::openThread(const QString &tid) {
    if (tid.isEmpty()) return;
    if (tid == m_tid) {
        markRead(tid);
        return;
    }
    ++m_generation;
    m_tid = tid;
    m_msgs.clear();
    m_pending.clear();
    m_hasOlder = false;
    m_loadingOlder = false;
    m_detail.clear();

    for (const auto &t : std::as_const(m_allThreads))
        if (t.value("tid") == tid) {
            m_detail = {{"tid", tid}, {"title", t.value("title")}, {"isGroup", t.value("is_group")}, {"conversations", QVariantList{}}};
            break;
        }
    QFile f(cacheFile("t/" + tid + ".json"));
    if (f.open(QIODevice::ReadOnly)) {
        const QJsonObject o = QJsonDocument::fromJson(f.readAll()).object();
        if (o.contains("detail")) m_detail = o.value("detail").toObject().toVariantMap();
        for (const auto &v : o.value("messages").toArray()) m_msgs << v.toObject().toVariantMap();
        m_hasOlder = m_msgs.size() >= kPage;
    }
    applyMessages();
    emit currentChanged();
    emit olderChanged();

    const int gen = m_generation;
    handle(call("GET", "/api/threads/" + tid), [this, gen](const QJsonDocument &doc) {
        if (gen != m_generation) return;
        m_detail = doc.object().toVariantMap();
        emit currentChanged();
        saveThreadCache(m_tid);
    });
    refreshCurrent();
    markRead(tid);
}

void Hub::closeThread() {
    ++m_generation;
    m_tid.clear();
    m_detail.clear();
    m_msgs.clear();
    m_pending.clear();
    m_hasOlder = false;
    m_loadingOlder = false;
    m_messageModel.setRows({});
    emit currentChanged();
    emit olderChanged();
}

void Hub::releaseView() {
    closeThread();
    m_filter.clear();
    m_resultModel.setRows({});
    rebuildThreadModel();
    m_windowActive = false;
}

void Hub::saveThreadCache(const QString &tid) {
    if (tid.isEmpty() || tid != m_tid) return;
    QDir().mkpath(QFileInfo(cacheFile("t/x")).absolutePath());
    QSaveFile f(cacheFile("t/" + tid + ".json"));
    if (!f.open(QIODevice::WriteOnly)) return;
    QJsonArray msgs;
    for (int i = 0; i < m_msgs.size() && i < kPage; ++i) msgs << QJsonObject::fromVariantMap(m_msgs.at(i));
    f.write(QJsonDocument(QJsonObject{{"detail", QJsonObject::fromVariantMap(m_detail)}, {"messages", msgs}})
                .toJson(QJsonDocument::Compact));
    f.commit();
}

void Hub::refreshCurrent() {
    if (m_tid.isEmpty() || !signedIn()) return;
    const int gen = m_generation;
    const QString tid = m_tid;
    handle(call("GET", QStringLiteral("/api/threads/%1/messages?limit=%2").arg(tid).arg(kPage)), [this, gen, tid](const QJsonDocument &doc) {
        if (gen != m_generation) return;
        QList<QVariantMap> page = toRows(doc);
        std::reverse(page.begin(), page.end());  // newest first
        const bool first = m_msgs.isEmpty() || m_msgs.size() < kPage;
        // Keep older messages that were loaded by scrolling up.
        QSet<qint64> ids;
        for (const auto &m : std::as_const(page)) ids.insert(m.value("id").toLongLong());
        const QDateTime oldest = page.isEmpty() ? QDateTime() : parseTime(page.last().value("sent_at"));
        for (const auto &m : std::as_const(m_msgs))
            if (!ids.contains(m.value("id").toLongLong()) && oldest.isValid() && parseTime(m.value("sent_at")) < oldest) page << m;
        m_msgs = page;
        if (first) {
            m_hasOlder = m_msgs.size() >= kPage;
            emit olderChanged();
        }
        // Drop sent placeholders once the real message is back: a message from me, newer than anything that was
        // shown when it was sent, with the same text (or any attachment, for a file). IDs, not clocks, so a Mac whose
        // clock is off doesn't leave duplicates.
        const qint64 now = QDateTime::currentMSecsSinceEpoch();
        QSet<qint64> claimed;
        for (int i = int(m_pending.size()) - 1; i >= 0; --i) {
            const auto &p = m_pending.at(i);
            if (p.value("state") != "sent") continue;
            const qint64 after = p.value("afterId").toLongLong();
            bool landed = now - p.value("created").toLongLong() > 120000;
            for (int j = 0; j < m_msgs.size() && j < 40 && !landed; ++j) {
                const auto &m = m_msgs.at(j);
                const qint64 id = m.value("id").toLongLong();
                if (!m.value("from_me").toBool() || id <= after || claimed.contains(id)) continue;
                landed = p.value("isFile").toBool() ? !m.value("attachments").toList().isEmpty()
                                                    : m.value("body").toString().trimmed() == p.value("body").toString().trimmed();
                if (landed) claimed.insert(id);
            }
            if (landed) m_pending.removeAt(i);
        }
        applyMessages();
        saveThreadCache(tid);
    });
}

void Hub::loadOlder() {
    if (m_tid.isEmpty() || !m_hasOlder || m_loadingOlder || m_msgs.isEmpty()) return;
    m_loadingOlder = true;
    emit olderChanged();
    const int gen = m_generation;
    QUrlQuery qs;
    qs.addQueryItem("limit", QString::number(kPage));
    qs.addQueryItem("before", m_msgs.last().value("sent_at").toString());
    handle(call("GET", "/api/threads/" + m_tid + "/messages?" + qs.toString(QUrl::FullyEncoded)), [this, gen](const QJsonDocument &doc) {
        if (gen != m_generation) return;
        QList<QVariantMap> older = toRows(doc);
        std::reverse(older.begin(), older.end());
        m_msgs << older;
        m_hasOlder = older.size() >= kPage;
        m_loadingOlder = false;
        emit olderChanged();
        applyMessages();
    }, [this, gen](int, const QString &) {
        if (gen != m_generation) return;
        m_loadingOlder = false;
        emit olderChanged();
    });
}

void Hub::applyMessages() {
    if (m_tid.isEmpty()) {
        m_messageModel.setRows({});
        return;
    }
    const bool group = m_detail.value("isGroup").toBool();
    QList<QVariantMap> all;
    all.reserve(m_pending.size() + m_msgs.size());
    for (const auto &p : std::as_const(m_pending)) all << p;
    for (const auto &m : std::as_const(m_msgs)) all << m;

    QList<QVariantMap> rows;
    rows.reserve(all.size());
    QList<QDateTime> times;
    times.reserve(all.size());
    for (const auto &m : std::as_const(all)) times << parseTime(m.value("sent_at"));

    auto sameSender = [&](int a, int b) {
        const auto &x = all.at(a), &y = all.at(b);
        return x.value("kind") != "system" && y.value("kind") != "system" && x.value("from_me") == y.value("from_me") &&
               (x.value("from_me").toBool() || x.value("sender_name") == y.value("sender_name"));
    };
    // all[i + 1] is the older neighbour (the list runs newest first).
    auto separatorBefore = [&](int i) {  // between all[i] and the message before it in time
        if (i + 1 >= all.size()) return !m_hasOlder;
        const QDateTime &a = times.at(i), &b = times.at(i + 1);
        return a.date() != b.date() || b.secsTo(a) > 3600;
    };

    bool statusShown = false;
    for (int i = 0; i < all.size(); ++i) {
        const QVariantMap &m = all.at(i);
        const bool pending = m.contains("localKey");
        const bool fromMe = m.value("from_me").toBool();
        const bool sep = separatorBefore(i);
        const bool joinsOlder = !sep && i + 1 < all.size() && sameSender(i, i + 1);
        const bool joinsNewer = i > 0 && !separatorBefore(i - 1) && sameSender(i, i - 1);
        // iMessage puts U+FFFC where an attachment sits in the text.
        QString body = m.value("body").toString();
        body.remove(QChar(0xFFFC));
        body = body.trimmed();

        QString statusText;
        bool failed = false;
        if (fromMe && !statusShown) {
            const QString st = pending ? m.value("state").toString() : m.value("status").toString();
            if (st == "failed") { statusText = QStringLiteral("Not Delivered"); failed = true; }
            else if (st == "sending") statusText = QStringLiteral("Sending…");
            else if (!m.value("read_at").toString().isEmpty())
                statusText = QStringLiteral("Read ") + clockText(parseTime(m.value("read_at")));
            else if (!m.value("delivered_at").toString().isEmpty()) statusText = QStringLiteral("Delivered");
            else if (pending || i == 0) statusText = QStringLiteral("Sent");
            statusShown = true;
        } else if (pending && m.value("state") == "failed") {
            statusText = QStringLiteral("Not Delivered");
            failed = true;
        }
        if (!fromMe && i == 0) statusShown = true;  // status only under the last message, as in Messages.app

        QVariantMap row{
            {"key", pending ? m.value("localKey").toString() : "m" + m.value("id").toString()},
            {"id", m.value("id")},
            {"fromMe", fromMe},
            {"kind", m.value("kind").toString().isEmpty() ? QStringLiteral("text") : m.value("kind").toString()},
            {"html", richText(body)},
            {"body", body},
            {"jumbo", jumboEmoji(body.trimmed()) && m.value("attachments").toList().isEmpty() && m.value("reply_to_body").isNull()},
            {"time", clockText(times.at(i))},
            {"service", m.value("service").toString().isEmpty() ? QStringLiteral("imessage") : m.value("service").toString()},
            {"senderName", m.value("sender_name").toString()},
            {"showName", group && !fromMe && !joinsOlder},
            {"separator", sep && times.at(i).isValid() ? separatorText(times.at(i)) : QString()},
            {"tail", !joinsNewer},
            {"statusText", statusText},
            {"failed", failed},
            {"pending", pending},
            {"attachments", m.value("attachments").toList()},
            {"reactions", m.value("reactions").toList()},
            {"replyName", m.value("reply_to_from_me").toBool() ? QStringLiteral("You") : m.value("reply_to_name").toString()},
            {"replyBody", oneLine(m.value("reply_to_body").toString(), 120)},
            {"unsent", m.value("unsent").toBool()},
            {"edited", !m.value("edited_at").toString().isEmpty()},
            {"pinned", !pending && !m.value("unsent").toBool() && !m.value("pinned_at").toString().isEmpty()},
        };
        rows << row;
    }
    m_messageModel.setRows(rows);
    if (m_revealId) tryReveal();
}

void Hub::refreshDetail() {
    if (m_tid.isEmpty() || !signedIn()) return;
    const int gen = m_generation;
    handle(call("GET", "/api/threads/" + m_tid), [this, gen](const QJsonDocument &doc) {
        if (gen != m_generation) return;
        m_detail = doc.object().toVariantMap();
        emit currentChanged();
        saveThreadCache(m_tid);
    });
}

void Hub::pinMessage(qint64 id, bool pin) {
    if (m_tid.isEmpty()) return;
    // Show it at once; the hub's answer (and the live event for other apps) settles the real state.
    for (auto &m : m_msgs)
        if (m.value("id").toLongLong() == id) m["pinned_at"] = pin ? isoNow() : QString();
    applyMessages();
    const QString path = QStringLiteral("/api/messages/%1/%2").arg(id).arg(pin ? "pin" : "unpin");
    auto done = [this](const QJsonDocument &) { refreshCurrent(); refreshDetail(); };
    handle(call("POST", path, "{}"), done, [this](int, const QString &e) { setError(e); refreshCurrent(); });
}

// Scroll target: wait for the message to be loaded (paging back through older messages), then tell the view its row.
void Hub::revealMessage(qint64 id) {
    m_revealId = id;
    tryReveal();
}

void Hub::tryReveal() {
    const auto &rows = m_messageModel.rows();
    const QString key = "m" + QString::number(m_revealId);
    for (int i = 0; i < rows.size(); ++i)
        if (rows.at(i).value("key").toString() == key) {
            const qint64 id = m_revealId;
            m_revealId = 0;
            emit revealRequested(i, id);
            return;
        }
    if (m_hasOlder && !m_loadingOlder) loadOlder();
    else if (!m_hasOlder && !m_loadingOlder) m_revealId = 0;  // not in this conversation any more
}

void Hub::setWindowActive(bool a) {
    if (a == m_windowActive) return;
    m_windowActive = a;
    emit windowActiveChanged();
    if (a && !m_tid.isEmpty()) {
        markRead(m_tid);
        Platform::instance()->withdraw(m_tid);  // clear this chat's notification once it is on screen
    }
}

void Hub::markRead(const QString &tid) {
    bool had = false;
    for (auto &t : m_allThreads)
        if (t.value("tid") == tid && t.value("unread").toInt() > 0) { t["unread"] = 0; had = true; }
    if (had) rebuildThreadModel();
    // WhatsApp read receipts go out even with no unread count (the hub decides), so always tell it.
    handle(call("POST", "/api/threads/" + tid + "/read"), {});
}

// ---------- sending ----------

namespace {
QString serviceFor(const QVariantMap &detail, int conversationId) {
    for (const auto &c : detail.value("conversations").toList()) {
        const QVariantMap cm = c.toMap();
        if (conversationId == 0 || cm.value("id").toInt() == conversationId) return cm.value("lastService").toString();
    }
    return QStringLiteral("imessage");
}
}  // namespace

qint64 Hub::newestId() const {
    qint64 id = 0;
    for (int i = 0; i < m_msgs.size() && i < 40; ++i) id = qMax(id, m_msgs.at(i).value("id").toLongLong());
    return id;
}

void Hub::send(const QString &textIn, int conversationId, int replyToId) {
    const QString text = textIn.trimmed();
    if (text.isEmpty() || m_tid.isEmpty()) return;
    static int counter = 0;
    QVariantMap p{{"localKey", "p" + QString::number(++counter)}, {"from_me", true}, {"kind", "text"}, {"body", text},
                  {"sent_at", isoNow()}, {"state", "sending"}, {"service", serviceFor(m_detail, conversationId)},
                  {"created", QDateTime::currentMSecsSinceEpoch()}, {"conversationId", conversationId},
                  {"replyToId", replyToId}, {"afterId", newestId()}};
    m_pending.prepend(p);
    applyMessages();

    moveToTop(m_tid, text);

    QJsonObject body{{"text", text}};
    if (conversationId) body.insert("conversationId", conversationId);
    if (replyToId) body.insert("replyToId", replyToId);
    const QString key = p.value("localKey").toString();
    const int gen = m_generation;
    auto mark = [this, key, gen](const QString &state) {
        if (gen != m_generation) return;
        for (auto &x : m_pending)
            if (x.value("localKey") == key) { x["state"] = state; x["created"] = QDateTime::currentMSecsSinceEpoch(); }
        applyMessages();
    };
    ++m_writes;
    const QString tid = m_tid;
    handle(call("POST", "/api/threads/" + m_tid + "/send", QJsonDocument(body).toJson()),
           [this, mark, tid](const QJsonDocument &) { --m_writes; mark("sent"); m_messagesTimer.start(); emit sendResult(tid, true, {}); },
           [this, mark, tid](int, const QString &e) { --m_writes; mark("failed"); setError(e); emit sendResult(tid, false, e); });
}

// Move a chat to the top of the inbox with what I just sent, before the hub confirms it.
void Hub::moveToTop(const QString &tid, const QString &text) {
    for (int i = 0; i < m_allThreads.size(); ++i)
        if (m_allThreads.at(i).value("tid") == tid) {
            QVariantMap t = m_allThreads.takeAt(i);
            t["last_body"] = text; t["last_from_me"] = true; t["last_at"] = isoNow(); t["last_unsent"] = false;
            t["last_has_attachment"] = false; t["unread"] = 0;
            m_allThreads.prepend(decorateThread(t));
            rebuildThreadModel();
            return;
        }
}

void Hub::sendTo(const QString &tid, const QString &textIn) {
    const QString text = textIn.trimmed();
    if (tid.isEmpty() || text.isEmpty() || !signedIn()) {
        emit sendResult(tid, false, signedIn() ? QStringLiteral("Nothing to send") : QStringLiteral("Not signed in"));
        return;
    }
    if (tid == m_tid) {  // the open chat: the usual path, so the window shows it as it goes out
        send(text, 0, 0);
        return;
    }
    moveToTop(tid, text);
    markRead(tid);  // replying means it has been seen
    ++m_writes;
    handle(call("POST", "/api/threads/" + tid + "/send", QJsonDocument(QJsonObject{{"text", text}}).toJson()),
           [this, tid](const QJsonDocument &) { --m_writes; scheduleThreads(1500); emit sendResult(tid, true, {}); },
           [this, tid](int, const QString &e) { --m_writes; scheduleThreads(0); emit sendResult(tid, false, e); });
}

QJsonObject Hub::islandState(int threads) const {
    QJsonArray list;
    for (int i = 0; i < m_allThreads.size() && i < threads; ++i) {
        const QVariantMap &t = m_allThreads.at(i);
        list << QJsonObject{{"tid", t.value("tid").toString()}, {"title", t.value("title").toString()},
                            {"initials", t.value("initials").toString()}, {"time", t.value("time").toString()},
                            {"preview", t.value("preview").toString()}, {"unread", t.value("unread").toInt()},
                            {"service", t.value("service").toString()}, {"isGroup", t.value("isGroup").toBool()},
                            {"muted", t.value("muted").toBool()}};
    }
    return QJsonObject{{"type", "state"}, {"signedIn", signedIn()}, {"online", m_online}, {"unread", m_unreadTotal},
                       {"threads", list}};
}

void Hub::retry(const QString &localKey) {
    for (int i = 0; i < m_pending.size(); ++i) {
        const QVariantMap p = m_pending.at(i);
        if (p.value("localKey") != localKey || p.value("state") != "failed") continue;
        m_pending.removeAt(i);
        if (p.value("isFile").toBool()) sendFiles({QUrl::fromLocalFile(p.value("path").toString())}, p.value("conversationId").toInt());
        else send(p.value("body").toString(), p.value("conversationId").toInt(), p.value("replyToId").toInt());
        return;
    }
}

void Hub::sendFiles(const QList<QUrl> &files, int conversationId) {
    if (m_tid.isEmpty()) return;
    static int counter = 0;
    static QMimeDatabase mimes;
    for (const QUrl &u : files) {
        const QString path = u.isLocalFile() ? u.toLocalFile() : u.toString();
        QFileInfo fi(path);
        if (!fi.isFile()) continue;
        auto *file = new QFile(path);
        if (!file->open(QIODevice::ReadOnly)) { delete file; setError("Could not read " + fi.fileName()); continue; }

        const QString key = "f" + QString::number(++counter);
        m_pending.prepend({{"localKey", key}, {"from_me", true}, {"kind", "text"}, {"body", QString::fromUtf8("\U0001F4CE ") + fi.fileName()},
                           {"sent_at", isoNow()}, {"state", "sending"}, {"service", serviceFor(m_detail, conversationId)},
                           {"created", QDateTime::currentMSecsSinceEpoch()}, {"conversationId", conversationId},
                           {"isFile", true}, {"path", path}, {"afterId", newestId()}});

        auto *multi = new QHttpMultiPart(QHttpMultiPart::FormDataType);
        if (conversationId) {  // fields first: the hub reads them before the file
            QHttpPart part;
            part.setHeader(QNetworkRequest::ContentDispositionHeader, "form-data; name=\"conversationId\"");
            part.setBody(QByteArray::number(conversationId));
            multi->append(part);
        }
        QHttpPart filePart;
        filePart.setHeader(QNetworkRequest::ContentTypeHeader, mimes.mimeTypeForFile(fi).name());
        QString name = fi.fileName();
        name.replace('"', '_');
        filePart.setHeader(QNetworkRequest::ContentDispositionHeader,
                           QStringLiteral("form-data; name=\"file\"; filename=\"%1\"").arg(name).toUtf8());
        filePart.setBodyDevice(file);
        file->setParent(multi);
        multi->append(filePart);

        QNetworkReply *reply = m_nam.post(request("/api/threads/" + m_tid + "/send-file"), multi);
        multi->setParent(reply);
        const int gen = m_generation;
        auto mark = [this, key, gen](const QString &state) {
            if (gen != m_generation) return;
            for (auto &x : m_pending)
                if (x.value("localKey") == key) { x["state"] = state; x["created"] = QDateTime::currentMSecsSinceEpoch(); }
            applyMessages();
        };
        ++m_writes;
        handle(reply, [this, mark](const QJsonDocument &) { --m_writes; mark("sent"); m_messagesTimer.start(); },
               [this, mark](int, const QString &e) { --m_writes; mark("failed"); setError(e); });
    }
    applyMessages();
}

// The system's file picker. The files go to the chat that was open when it was asked for, if it still is.
void Hub::pickFile(int conversationId) {
    const QString tid = m_tid;
    Platform::instance()->pickFiles(
        QStringLiteral("Send a File"),
        [this, tid, conversationId](const QList<QUrl> &urls) { if (tid == m_tid) sendFiles(urls, conversationId); },
        [this](const QString &error) { setError(error); });
}

// ---------- attachments ----------

void Hub::fetchAttachment(qint64 id, int width, bool retry, std::function<void(QString, QString)> done) {
    const QString name = QString::number(id) + (width ? "w" + QString::number(width) : QString());
    const QString path = cacheFile("att/" + name);
    if (QFileInfo::exists(path)) {
        done(path, {});
        return;
    }
    auto it = m_fetching.find(name);
    if (it != m_fetching.end()) {
        it->append(std::move(done));
        return;
    }
    m_fetching.insert(name, {std::move(done)});
    QDir().mkpath(QFileInfo(path).absolutePath());
    auto *part = new QFile(path + ".part");
    QUrlQuery qs;
    if (width) qs.addQueryItem("w", QString::number(width));
    if (retry) qs.addQueryItem("retry", "1");
    QNetworkReply *reply = m_nam.get(request("/api/attachments/" + QString::number(id) + (qs.isEmpty() ? QString() : "?" + qs.toString())));
    part->setParent(reply);
    const bool opened = part->open(QIODevice::WriteOnly);
    // Stream to disk, so a large video never sits in memory.
    connect(reply, &QIODevice::readyRead, reply, [reply, part, opened] {
        if (opened && reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt() == 200) part->write(reply->readAll());
    });
    connect(reply, &QNetworkReply::finished, this, [this, reply, part, path, name, opened] {
        reply->deleteLater();
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        QString err;
        if (status == 200 && opened) {
            part->write(reply->readAll());
            part->close();
            QFile::remove(path);
            if (!QFile::rename(part->fileName(), path)) err = QStringLiteral("Could not save the attachment");
        } else {
            part->close();
            part->remove();
            err = QJsonDocument::fromJson(reply->readAll()).object().value("error").toString();
            if (err.isEmpty()) err = status ? QStringLiteral("Not available (%1)").arg(status) : reply->errorString();
            if (status == 401 && signedIn()) signedOut();
        }
        const auto callbacks = m_fetching.take(name);
        for (const auto &cb : callbacks) cb(err.isEmpty() ? path : QString(), err);
    });
}

void Hub::fetchAvatar(const QString &tid, const QString &version, std::function<void(QString, QString)> done) {
    // The version is part of the file name: a changed photo is simply a new file, and old ones are never read again.
    const QString name = tid + '-' + version;
    const QString path = cacheFile("av/" + name);
    if (QFileInfo::exists(path)) {
        done(path, {});
        return;
    }
    auto it = m_fetching.find("av:" + name);
    if (it != m_fetching.end()) {
        it->append(std::move(done));
        return;
    }
    m_fetching.insert("av:" + name, {std::move(done)});
    QNetworkReply *reply = m_nam.get(request("/api/avatars/" + tid + "?w=128&v=" + version));
    connect(reply, &QNetworkReply::finished, this, [this, reply, path, name] {
        reply->deleteLater();
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        QString err;
        if (status == 200) {
            QDir().mkpath(QFileInfo(path).absolutePath());
            QSaveFile f(path);
            if (!f.open(QIODevice::WriteOnly) || f.write(reply->readAll()) < 0 || !f.commit()) err = QStringLiteral("Could not save the photo");
        } else {
            err = status ? QStringLiteral("No photo (%1)").arg(status) : reply->errorString();
            if (status == 401 && signedIn()) signedOut();
        }
        const auto callbacks = m_fetching.take("av:" + name);
        for (const auto &cb : callbacks) cb(err.isEmpty() ? path : QString(), err);
    });
}

void Hub::openAttachment(qint64 id, const QString &filename) {
    fetchAttachment(id, 0, false, [this, id, filename](const QString &path, const QString &err) {
        if (!err.isEmpty()) { setError(err); return; }
        // Open it under its real name, so the right app picks it up.
        QString name = QFileInfo(filename).fileName();
        if (name.isEmpty()) name = QString::number(id);
        const QString dir = cacheFile("open/" + QString::number(id));
        QDir().mkpath(dir);
        const QString link = dir + '/' + name;
        if (!QFileInfo::exists(link)) QFile::link(path, link);
        QDesktopServices::openUrl(QUrl::fromLocalFile(link));
    });
}

void Hub::copyText(const QString &text) { QGuiApplication::clipboard()->setText(text); }

void Hub::openLink(const QString &url) {
    const QUrl u(url);
    if (u.scheme() == "http" || u.scheme() == "https" || u.scheme() == "mailto" || u.scheme() == "tel") QDesktopServices::openUrl(u);
}

// ---------- live updates ----------

void Hub::connectLive() {
    if (!signedIn() || m_server.isEmpty()) return;
    if (m_ws.state() != QAbstractSocket::UnconnectedState) return;
    QUrl u(m_server + "/api/live");
    u.setScheme(u.scheme() == "https" ? "wss" : "ws");
    QNetworkRequest r = request({});
    r.setUrl(u);
    // The hub only lets its own pages open the live feed (it checks Origin against its host), so say where we belong.
    const QUrl base(m_server);
    r.setRawHeader("Origin", (base.scheme() + "://" + base.authority()).toUtf8());
    m_ws.open(r);
}

void Hub::onLive(const QString &text) {
    const QVariantMap ev = QJsonDocument::fromJson(text.toUtf8()).object().toVariantMap();
    const QString type = ev.value("type").toString();
    const int convId = ev.value("conversationId").toInt();
    bool inCurrent = false;
    for (const auto &c : m_detail.value("conversations").toList())
        if (c.toMap().value("id").toInt() == convId) inCurrent = true;

    if (type == "message") {
        const QString tid = ev.value("tid").toString();
        const QVariantMap preview = ev.value("preview").toMap();
        const bool fromMe = ev.value("fromMe").toBool();
        if (inCurrent || (!tid.isEmpty() && tid == m_tid)) m_messagesTimer.start();
        bool patched = false;
        if (!tid.isEmpty() && !preview.isEmpty()) {
            for (int i = 0; i < m_allThreads.size(); ++i) {
                if (m_allThreads.at(i).value("tid") != tid) continue;
                QVariantMap t = m_allThreads.takeAt(i);
                t["last_body"] = preview.value("body");
                t["last_from_me"] = fromMe;
                t["last_service"] = preview.value("service");
                t["last_sender_name"] = preview.value("sender_name");
                t["last_has_attachment"] = preview.value("has_attachment");
                t["last_unsent"] = false;
                t["last_at"] = isoNow();
                const bool reading = tid == m_tid && m_windowActive;
                if (!fromMe && !reading) t["unread"] = t.value("unread").toInt() + 1;
                m_allThreads.prepend(decorateThread(t));
                rebuildThreadModel();
                patched = true;
                if (reading && !fromMe) markRead(tid);
                break;
            }
        }
        // The local patch shows it at once; the hub's own list follows a little later.
        scheduleThreads(patched ? 5000 : 300);
        // Chats muted on the phone and archived chats stay quiet here too: no notification and no island banner.
        if (!fromMe && !preview.isEmpty() && !preview.value("muted").toBool() && !preview.value("archived").toBool()) {
            QVariantMap m = preview;
            QString who = preview.value("sender_name").toString();
            if (who.isEmpty()) who = preview.value("title").toString();
            QString body = oneLine(preview.value("body").toString().remove(QChar(0xFFFC)), 300);
            if (body.isEmpty() && preview.value("has_attachment").toBool()) body = QStringLiteral("Sent an attachment");
            m["sender"] = who;
            m["initials"] = initialsOf(preview.value("is_group").toBool() && !preview.value("title").toString().isEmpty() ? preview.value("title").toString() : who);
            m["text"] = body;
            m["time"] = clockText(QDateTime::currentDateTime());
            emit incoming(m);
            if (m_islandClients == 0) notify(preview);  // the island shows it instead
        }
    } else if (type == "message-updated") {
        if (inCurrent) { m_messagesTimer.start(); m_detailTimer.start(); }
        scheduleThreads(3000);
    } else if (type == "conversation-updated") {
        scheduleThreads(1500);
    } else if (type == "refresh" || type == "send-request") {  // send-request: a message approved in the web app went out
        scheduleThreads(1500);
        if (!m_tid.isEmpty()) m_messagesTimer.start();
    }
}

// ---------- notifications ----------

void Hub::notify(const QVariantMap &p) {
    const QString tid = p.value("tid").toString();
    if (m_windowActive && tid == m_tid) return;
    const QString who = p.value("sender_name").toString().isEmpty() ? QStringLiteral("Someone") : p.value("sender_name").toString();
    const QString title = p.value("is_group").toBool() && !p.value("title").toString().isEmpty()
                              ? who + QStringLiteral(" in ") + p.value("title").toString()
                              : who;
    QString body = oneLine(p.value("body").toString(), 300);
    if (body.isEmpty() && p.value("has_attachment").toBool()) body = QStringLiteral("Sent an attachment");

    Platform::instance()->notify(tid, title, body);
}
