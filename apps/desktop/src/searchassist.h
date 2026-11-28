#pragma once

#include <QList>
#include <QObject>
#include <QString>
#include <QVariantList>
#include <QVariantMap>
#include <qqmlintegration.h>

class QQmlEngine;
class QJSEngine;

// Helpers for typing: suggestions for the search box's filters ("from:", "has:", ...) and :emoji: shortcodes in the composer.
// The hub understands the filters (apps/hub/src/searchquery.ts); this only helps write them, mirroring apps/web/src/searchSuggest.ts
// and apps/web/src/emoji/emoji.ts. Positions are QString indexes, the same ones TextInput/TextEdit use.
class SearchAssist : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_SINGLETON

public:
    static SearchAssist *instance();
    static SearchAssist *create(QQmlEngine *, QJSEngine *);

    struct Person { QString title; bool isGroup = false; };
    /// Used by Hub to give suggestions the conversation names. Passing the list avoids this class knowing about Hub.
    void setPeople(const QList<Person> &people) { m_people = people; }

    /// What the search text looks like without its "from: x" style filters, and whether it had any.
    static QString freeText(const QString &query, bool *hadFilters = nullptr);

    /// Suggestions for the word ending at `caret`: {start, end, items:[{label, hint, insert, info, more}]}, or an empty map.
    Q_INVOKABLE QVariantMap complete(const QString &query, int caret) const;
    /// All filters, for an empty search box.
    Q_INVOKABLE QVariantMap operators() const;

    /// The ":smi" being typed before the caret: {start, query}, or an empty map.
    Q_INVOKABLE QVariantMap emojiTrigger(const QString &text, int caret) const;
    /// A just-finished ":smile:" before the caret: {start, emoji}, or an empty map.
    Q_INVOKABLE QVariantMap emojiComplete(const QString &text, int caret) const;
    /// Matches for a typed name, best first: [{emoji, name}].
    Q_INVOKABLE QVariantList emojiSearch(const QString &query, int limit = 8) const;

private:
    SearchAssist() = default;
    struct Emoji { QString glyph; QStringList names; };
    const QList<Emoji> &emoji() const;

    QList<Person> m_people;
};
