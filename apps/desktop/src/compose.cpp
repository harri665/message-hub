// Starting new conversations: contact suggestions, which services reach an address, and the first message.
#include <QJsonArray>
#include <QJsonObject>
#include <QUrl>

#include "hub.h"

void Hub::searchContacts(const QString &q) {
    const QString path = QStringLiteral("/api/contacts?q=") + QString::fromUtf8(QUrl::toPercentEncoding(q));
    handle(call("GET", path), [this, q](const QJsonDocument &d) { emit contactsReady(q, d.array().toVariantList()); },
           [this, q](int, const QString &) { emit contactsReady(q, {}); });
}

void Hub::checkAddress(const QString &address) {
    const QString path = QStringLiteral("/api/compose/check?address=") + QString::fromUtf8(QUrl::toPercentEncoding(address));
    handle(call("GET", path), [this, address](const QJsonDocument &d) { emit addressChecked(address, d.object().toVariantMap()); },
           [this, address](int, const QString &) { emit addressChecked(address, {}); });
}

void Hub::compose(const QStringList &addresses, const QString &service, const QString &text) {
    QJsonArray list;
    for (const QString &a : addresses) list.append(a);
    const QByteArray body = QJsonDocument(QJsonObject{{"addresses", list}, {"service", service}, {"text", text}}).toJson(QJsonDocument::Compact);
    handle(call("POST", QStringLiteral("/api/compose"), body),
           [this](const QJsonDocument &d) {
               const QString tid = d.object().value("tid").toString();
               refresh();
               openThread(tid);
               emit composeResult(true, tid, {});
           },
           [this](int, const QString &e) { emit composeResult(false, {}, e); });
}
