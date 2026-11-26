#pragma once

#include <QAbstractListModel>
#include <QList>
#include <QVariantMap>
#include <qqmlintegration.h>

// A list model of JSON-like rows (QVariantMap) with a fixed set of roles.
// setRows() applies the smallest set of removes, moves, inserts and changes, so ListView keeps its scroll position,
// recycles its delegates and only redraws the rows that really changed.
class JsonListModel : public QAbstractListModel {
    Q_OBJECT
    QML_ELEMENT
    QML_UNCREATABLE("Provided by Hub")
    Q_PROPERTY(int count READ count NOTIFY countChanged)

public:
    JsonListModel(QList<QByteArray> roles, QString keyField, QObject *parent = nullptr);

    int rowCount(const QModelIndex &parent = {}) const override;
    QVariant data(const QModelIndex &index, int role) const override;
    QHash<int, QByteArray> roleNames() const override;

    int count() const { return int(m_rows.size()); }
    const QList<QVariantMap> &rows() const { return m_rows; }
    void setRows(const QList<QVariantMap> &rows);
    Q_INVOKABLE QVariantMap get(int row) const;

signals:
    void countChanged();

private:
    QString keyOf(const QVariantMap &row) const { return row.value(m_key).toString(); }

    QList<QVariantMap> m_rows;
    QList<QByteArray> m_roles;
    QString m_key;
};
