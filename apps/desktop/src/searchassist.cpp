#include "searchassist.h"

#include <QFile>
#include <QJSEngine>
#include <QJsonArray>
#include <QJsonDocument>
#include <QRegularExpression>
#include <algorithm>

namespace {

struct Op { const char *name; const char *hint; };
const Op kOperators[] = {
    {"from", "messages from a person (or \"me\")"}, {"in", "one conversation"},
    {"has", "image, video, file, link, audio, sticker"}, {"before", "before a date"}, {"after", "after a date"},
    {"during", "on a day or in a month"}, {"is", "unread or reply"}, {"service", "imessage, sms or whatsapp"},
};
const QStringList kHas{"image", "video", "file", "link", "audio", "sticker", "attachment"};
const QStringList kIs{"unread", "reply"};
const QStringList kService{"imessage", "sms", "whatsapp"};
const QStringList kDates{"today", "yesterday"};
constexpr int kMax = 7;

QVariantMap item(const QString &label, const QString &insert, const QString &hint = {}, bool info = false, bool more = false) {
    return {{"label", label}, {"insert", insert}, {"hint", hint}, {"info", info}, {"more", more}};
}
QString quoted(const QString &v) { return v.contains(QRegularExpression("\\s")) ? '"' + v + '"' : v; }

const QString kOpNames = "from|in|has|before|after|during|is|service";

}  // namespace

SearchAssist *SearchAssist::instance() {
    static SearchAssist s;
    return &s;
}

SearchAssist *SearchAssist::create(QQmlEngine *, QJSEngine *) {
    QJSEngine::setObjectOwnership(instance(), QJSEngine::CppOwnership);
    return instance();
}

QString SearchAssist::freeText(const QString &query, bool *hadFilters) {
    static const QRegularExpression filter("\\b(?:" + kOpNames + "):[ \\t]*(?:\"[^\"]*\"|\\S+)", QRegularExpression::CaseInsensitiveOption);
    QString t = query;
    t.replace(filter, " ");
    t = t.simplified();
    if (hadFilters) *hadFilters = t != query.simplified();
    return t;
}

QVariantMap SearchAssist::operators() const {
    QVariantList items;
    for (const auto &o : kOperators) items << item(QString(o.name) + ':', QString(o.name) + ": ", o.hint, false, true);
    return {{"start", 0}, {"end", 0}, {"items", items}};
}

QVariantMap SearchAssist::complete(const QString &query, int caret) const {
    const QString before = query.left(caret);
    static const QRegularExpression quotedRe("(?:^|\\s)(" + kOpNames + "):[ \\t]*\"([^\"]*)$", QRegularExpression::CaseInsensitiveOption);
    static const QRegularExpression plainRe("(?:^|\\s)(" + kOpNames + "):[ \\t]*(\"?)([^\"\\s]*)$", QRegularExpression::CaseInsensitiveOption);
    const auto q = quotedRe.match(before);
    const auto m = q.hasMatch() ? QRegularExpressionMatch() : plainRe.match(before);
    if (q.hasMatch() || m.hasMatch()) {
        const QString op = (q.hasMatch() ? q.captured(1) : m.captured(1)).toLower();
        const QString partial = (q.hasMatch() ? q.captured(2) : m.captured(3)).toLower();
        const int valueLen = q.hasMatch() ? int(q.captured(2).size()) + 1 : int(m.captured(2).size() + m.captured(3).size());
        const int start = caret - valueLen;
        auto pick = [&](const QStringList &list) {
            QVariantList out;
            for (const auto &v : list)
                if (v.contains(partial)) out << item(v, v + ' ');
            return out;
        };
        QVariantList items;
        if (op == "has") items = pick(kHas);
        else if (op == "is") items = pick(kIs);
        else if (op == "service") items = pick(kService);
        else if (op == "from" || op == "in") {
            QStringList seen;
            if (op == "from" && QStringLiteral("me").startsWith(partial)) { items << item("me", "me ", "messages you sent"); seen << "me"; }
            QList<Person> list;
            for (const auto &p : m_people)
                if (op == "in" || !p.isGroup) list << p;
            QList<Person> starts, has;
            for (const auto &p : list) {
                if (p.title.toLower().startsWith(partial)) starts << p;
                else if (p.title.toLower().contains(partial)) has << p;
            }
            for (const auto &p : starts + has) {
                if (seen.contains(p.title) || items.size() >= kMax) continue;
                seen << p.title;
                items << item(p.title, quoted(p.title) + ' ', op == "in" && p.isGroup ? "group" : QString());
            }
        } else {
            for (const auto &v : kDates)
                if (v.contains(partial)) items << item(v, v + ' ');
            items << item("Try 2026-11-25, 2026-11, nov 25 or yesterday", "", "", true);
        }
        if (items.isEmpty()) return {};
        if (items.size() == 1) {
            const auto only = items.first().toMap();
            if (!only.value("info").toBool() && only.value("label").toString().toLower() == partial && !partial.contains(' ')) return {};
        }
        while (items.size() > kMax) items.removeLast();
        return {{"start", start}, {"end", caret}, {"items", items}};
    }
    static const QRegularExpression wordRe("(?:^|\\s)([a-zA-Z]{2,8})$");
    const auto w = wordRe.match(before);
    if (w.hasMatch()) {
        const QString word = w.captured(1).toLower();
        QVariantList items;
        for (const auto &o : kOperators)
            if (QString(o.name).startsWith(word) && QString(o.name) != word)
                items << item(QString(o.name) + ':', QString(o.name) + ": ", o.hint, false, true);
        if (!items.isEmpty()) return {{"start", caret - int(w.captured(1).size())}, {"end", caret}, {"items", items}};
    }
    return {};
}

// ---------- emoji ----------

const QList<SearchAssist::Emoji> &SearchAssist::emoji() const {
    // Names and emoji from emojibase-data (MIT, data/LICENSE-emojibase.txt), most popular first, compiled in as a resource.
    static const QList<Emoji> all = [] {
        QList<Emoji> out;
        QFile f(":/emoji/emoji-shortcodes.json");
        if (!f.open(QIODevice::ReadOnly)) return out;
        const auto arr = QJsonDocument::fromJson(f.readAll()).array();
        out.reserve(arr.size());
        for (const auto &v : arr) {
            const auto row = v.toArray();
            if (row.size() < 2) continue;
            Emoji e{row.at(0).toString(), {}};
            for (int i = 1; i < row.size(); ++i) e.names << row.at(i).toString();
            out << e;
        }
        return out;
    }();
    return all;
}

QVariantList SearchAssist::emojiSearch(const QString &query, int limit) const {
    const QString q = query.toLower();
    if (q.size() < 2) return {};
    struct Hit { int score; int rank; QString shown; const Emoji *e; };
    QList<Hit> hits;
    int rank = 0;
    for (const auto &e : emoji()) {
        int best = -1;
        QString shown = e.names.first();
        for (const auto &n : e.names) {
            const int s = n == q ? 0 : n.startsWith(q) ? 1 : n.contains('_' + q) ? 2 : n.contains(q) ? 3 : -1;
            if (s >= 0 && (best < 0 || s < best)) { best = s; shown = n; }
        }
        if (best >= 0) hits << Hit{best, rank, shown, &e};
        ++rank;
    }
    std::stable_sort(hits.begin(), hits.end(), [](const Hit &a, const Hit &b) { return a.score != b.score ? a.score < b.score : a.rank < b.rank; });
    QVariantList out;
    for (const auto &h : hits) {
        if (out.size() >= limit) break;
        out << QVariantMap{{"emoji", h.e->glyph}, {"name", h.shown}};
    }
    return out;
}

namespace {
bool inCode(const QString &text, int pos) { return text.left(pos).count('`') % 2 == 1; }
}

QVariantMap SearchAssist::emojiTrigger(const QString &text, int caret) const {
    static const QRegularExpression re("(?:^|\\s):([a-z0-9_+-]{2,})$", QRegularExpression::CaseInsensitiveOption);
    const auto m = re.match(text.left(caret));
    if (!m.hasMatch()) return {};
    const int start = caret - int(m.captured(1).size()) - 1;
    if (inCode(text, start)) return {};
    return {{"start", start}, {"query", m.captured(1)}};
}

QVariantMap SearchAssist::emojiComplete(const QString &text, int caret) const {
    static const QRegularExpression re("(?:^|\\s):([a-z0-9_+-]{2,}):$", QRegularExpression::CaseInsensitiveOption);
    const auto m = re.match(text.left(caret));
    if (!m.hasMatch()) return {};
    const int start = caret - int(m.captured(1).size()) - 2;
    if (inCode(text, start)) return {};
    const QString name = m.captured(1).toLower();
    for (const auto &e : emoji())
        if (e.names.contains(name)) return {{"start", start}, {"emoji", e.glyph}};
    return {};
}
