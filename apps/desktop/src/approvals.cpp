// Messages Claude asked to send (approved or rejected here), the hub's connection status line, and the inbox filter.
// These are the desktop versions of the web app's SendApprovals, the sidebar's status banner and its filter control.
#include "hub.h"

#include <QDateTime>
#include <QJsonArray>
#include <QJsonObject>
#include <QLocale>
#include <QNetworkReply>
#include <QStringList>

#include "theme.h"

namespace {
QString serviceLabel(const QString &s) {
    if (s == "imessage") return QStringLiteral("iMessage");
    if (s == "sms") return QStringLiteral("SMS");
    if (s == "rcs") return QStringLiteral("RCS");
    if (s == "whatsapp") return QStringLiteral("WhatsApp");
    return s;
}

QString whenText(const QString &iso) {
    const QDateTime d = QDateTime::fromString(iso, Qt::ISODateWithMs).toLocalTime();
    if (!d.isValid()) return {};
    const QString clock = QLocale().toString(d.time(), Theme::instance()->use24h() ? QStringLiteral("HH:mm") : QStringLiteral("h:mm AP"));
    if (d.date() == QDate::currentDate()) return clock;
    return QLocale().toString(d.date(), QStringLiteral("d MMM")) + QStringLiteral(", ") + clock;
}
}  // namespace

void Hub::initApprovals() {
    m_approvalsTimer.setInterval(60000);  // the live event does the quick work; this covers a dropped socket
    connect(&m_approvalsTimer, &QTimer::timeout, this, &Hub::refreshApprovals);
    m_statusTimer.setInterval(30000);
    connect(&m_statusTimer, &QTimer::timeout, this, &Hub::refreshStatus);
    connect(this, &Hub::signedInChanged, this, [this] {
        if (signedIn()) {
            refreshApprovals();
            refreshStatus();
            m_approvalsTimer.start();
            m_statusTimer.start();
            return;
        }
        m_approvalsTimer.stop();
        m_statusTimer.stop();
        m_approvals.clear();
        m_approvalsFailed.clear();
        m_approvalErrors.clear();
        m_approvalsBusy.clear();
        m_approvalsInflight.clear();
        if (m_statusReply) { m_statusReply->abort(); m_statusReply = nullptr; }
        m_statusText.clear();
        m_statusWarn = false;
        rebuildApprovalRows();
        emit statusChanged();
    });
    connect(this, &Hub::onlineChanged, this, [this] {  // reconnected: catch up on both
        if (!m_online || !signedIn()) return;
        refreshApprovals();
        refreshStatus();
    });
    // The session is read from the config after this runs, so look at it once the constructor is done.
    QTimer::singleShot(0, this, [this] {
        if (!signedIn()) return;
        refreshApprovals();
        refreshStatus();
        m_approvalsTimer.start();
        m_statusTimer.start();
    });
}

// ---------- send approvals ----------

int Hub::approvalCount() const { return int(m_approvals.size()); }

void Hub::setApprovalsOpen(bool open) {
    if (open == m_approvalsOpen) return;
    m_approvalsOpen = open;
    emit approvalsOpenChanged();
}

void Hub::rebuildApprovalRows() {
    QVariantList rows;
    auto add = [&](const QVariantMap &r, bool failed, bool gone = false) {
        const int id = r.value("id").toInt();
        QString title = r.value("thread_title").toString();
        if (title.isEmpty()) title = QStringLiteral("Unknown");
        QString reply;
        if (!r.value("reply_to_message_id").isNull() && r.value("reply_to_message_id").toInt() > 0) {
            reply = r.value("reply_to_from_me").toBool() ? QStringLiteral("Replying to your message") : QStringLiteral("Replying to their message");
            const QString b = r.value("reply_to_body").toString().simplified();
            if (!b.isEmpty()) reply += QStringLiteral(": \u201C") + b.left(160) + QStringLiteral("\u201D");
        }
        QString error = m_approvalErrors.value(id);
        if (gone) failed = !m_approvalsBusy.contains(id);  // no longer pending on the hub: only Dismiss, with the reason
        else if (failed) {
            const QString e = r.value("error").toString().isEmpty() ? QStringLiteral("unknown error") : r.value("error").toString();
            error = e.startsWith(QStringLiteral("Not sent"), Qt::CaseInsensitive) ? e : QStringLiteral("Not sent: ") + e;
        }
        rows << QVariantMap{{"id", id},
                            {"title", title},
                            {"service", serviceLabel(r.value("service").toString())},
                            {"when", whenText(r.value("created_at").toString())},
                            {"requestedBy", r.value("requested_by").toString()},
                            {"text", r.value("text").toString()},
                            {"replyText", reply},
                            {"error", error},
                            {"busy", m_approvalsBusy.contains(id)},
                            {"failed", failed}};
    };
    for (const auto &r : std::as_const(m_approvalsFailed)) add(r, true);
    for (const auto &r : std::as_const(m_approvals)) add(r, false);
    for (auto it = m_approvalsInflight.cbegin(); it != m_approvalsInflight.cend(); ++it) {
        bool listed = false;
        for (const auto &r : std::as_const(m_approvals)) listed = listed || r.value("id").toInt() == it.key();
        if (!listed) add(it.value(), false, true);
    }
    m_approvalRows = rows;
    emit approvalsChanged();
    if (rows.isEmpty()) setApprovalsOpen(false);
}

void Hub::refreshApprovals() {
    if (!signedIn()) return;
    handle(call("GET", "/api/send-requests?status=pending"), [this](const QJsonDocument &doc) {
        m_approvals.clear();
        QSet<int> ids;
        for (const auto &v : doc.array()) {
            const QVariantMap r = v.toObject().toVariantMap();
            ids << r.value("id").toInt();
            m_approvals << r;
        }
        for (auto it = m_approvalErrors.begin(); it != m_approvalErrors.end();)
            it = ids.contains(it.key()) || m_approvalsInflight.contains(it.key()) ? std::next(it) : m_approvalErrors.erase(it);
        for (auto it = m_approvalsInflight.begin(); it != m_approvalsInflight.end();)  // decided elsewhere, nothing to say
            it = m_approvalsBusy.contains(it.key()) || m_approvalErrors.contains(it.key()) ? std::next(it) : m_approvalsInflight.erase(it);
        rebuildApprovalRows();
    });
}

void Hub::approveSend(int id) { decideSend(id, true); }
void Hub::rejectSend(int id) { decideSend(id, false); }

void Hub::decideSend(int id, bool approve) {
    if (!signedIn() || m_approvalsBusy.contains(id)) return;
    // A failed one is only dismissed: it was already decided.
    bool listed = false;
    for (const auto &r : std::as_const(m_approvals)) listed = listed || r.value("id").toInt() == id;
    if (!listed && m_approvalsInflight.contains(id)) {  // a request the hub dropped, kept to show why: Dismiss
        m_approvalsInflight.remove(id);
        m_approvalErrors.remove(id);
        rebuildApprovalRows();
        return;
    }
    for (int i = 0; i < m_approvalsFailed.size(); ++i)
        if (m_approvalsFailed.at(i).value("id").toInt() == id) {
            m_approvalsFailed.removeAt(i);
            rebuildApprovalRows();
            return;
        }
    m_approvalsBusy << id;
    for (const auto &r : std::as_const(m_approvals))
        if (r.value("id").toInt() == id) m_approvalsInflight[id] = r;
    m_approvalErrors.remove(id);
    rebuildApprovalRows();
    const QString path = QStringLiteral("/api/send-requests/%1/%2").arg(id).arg(approve ? "approve" : "reject");
    handle(call("POST", path, "{}"),
           [this, id](const QJsonDocument &doc) {
               m_approvalsBusy.remove(id);
               const QVariantMap res = doc.object().toVariantMap();
               if (res.value("status").toString() == "failed" && m_approvalsInflight.contains(id)) {
                   QVariantMap f = m_approvalsInflight.value(id);
                   f["error"] = res.value("error");
                   m_approvalsFailed << f;
               }
               m_approvalsInflight.remove(id);
               for (int i = 0; i < m_approvals.size(); ++i)
                   if (m_approvals.at(i).value("id").toInt() == id) { m_approvals.removeAt(i); break; }
               rebuildApprovalRows();
               refreshApprovals();
               scheduleThreads(1500);
           },
           [this, id](int, const QString &e) {
               m_approvalsBusy.remove(id);
               m_approvalErrors[id] = e;  // the row stays listed (see rebuildApprovalRows) so the reason is not lost
               rebuildApprovalRows();
               refreshApprovals();
           });
}

// ---------- connection status ----------

void Hub::refreshStatus() {
    if (!signedIn() || m_statusReply) return;
    m_statusReply = call("GET", "/api/status");
    QNetworkReply *reply = m_statusReply;
    handle(reply, [this](const QJsonDocument &doc) {
        m_statusReply = nullptr;
        const QJsonObject s = doc.object();
        const QJsonObject bb = s.value("bluebubbles").toObject();
        const QJsonObject wa = s.value("whatsapp").toObject();
        QString text;
        bool warn = false;
        if (bb.value("importing").toBool()) {
            text = QStringLiteral("Importing your iMessage history\u2026");
        } else {
            QStringList problems;
            if (!bb.value("configured").toBool()) problems << QStringLiteral("iMessage is not connected");
            else if (!bb.value("connected").toBool()) problems << QStringLiteral("iMessage is offline");
            if (wa.value("configured").toBool() && !wa.value("loggedIn").toBool()) problems << QStringLiteral("WhatsApp is not linked");
            else if (wa.value("configured").toBool() && !wa.value("connected").toBool()) problems << QStringLiteral("WhatsApp is offline");
            if (!problems.isEmpty()) { text = problems.join(QStringLiteral(". ")) + QLatin1Char('.'); warn = true; }
        }
        if (text != m_statusText || warn != m_statusWarn) {
            m_statusText = text;
            m_statusWarn = warn;
            emit statusChanged();
        }
    }, [this](int, const QString &) { m_statusReply = nullptr; });  // the status row keeps what it had
    refreshAiUsage();
}

// ---------- AI usage (gear menu) ----------

void Hub::refreshAiUsage() {
    if (!signedIn() || m_aiUsageReply) return;
    m_aiUsageReply = call("GET", "/api/ai/status");
    handle(m_aiUsageReply, [this](const QJsonDocument &doc) {
        m_aiUsageReply = nullptr;
        const QJsonObject s = doc.object();
        QVariantMap u;
        if (s.value("enabled").toBool()) {
            u["owner"] = s.value("owner").toString();
            u["hubUsed"] = s.value("hubUsedToday").toInt();
            u["remaining"] = s.value("remaining").toInt();
            u["limit"] = s.value("limit").toInt();
            // Without Cloudflare's account-wide count, "remaining" only knows about this hub's own use.
            u["accountKnown"] = !s.value("account").toObject().value("usedToday").isNull();
        }
        if (u != m_aiUsage) {
            m_aiUsage = u;
            emit aiUsageChanged();
        }
    }, [this](int, const QString &) { m_aiUsageReply = nullptr; });  // an older hub without /api/ai/status: menu stays as is
}

void Hub::openHubSettings() {
    if (m_server.isEmpty()) return;
    openLink(m_server + QStringLiteral("/#/settings"));
}

// ---------- inbox filter ----------

void Hub::setInboxFilter(const QString &f) {
    const QString v = (f == "unread" || f == "apple" || f == "whatsapp") ? f : QStringLiteral("all");
    if (v == m_inboxFilter) return;
    m_inboxFilter = v;
    emit inboxFilterChanged();
    rebuildThreadModel();
}

QList<QVariantMap> Hub::applyInboxFilter(const QList<QVariantMap> &rows) const {
    if (m_inboxFilter == "all") return rows;
    QList<QVariantMap> out;
    for (const auto &t : rows) {
        if (m_inboxFilter == "unread" ? t.value("unread").toInt() > 0 : t.value("networks").toStringList().contains(m_inboxFilter)) out << t;
    }
    return out;
}
