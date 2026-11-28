#include "listmodel.h"

#include <QSet>

JsonListModel::JsonListModel(QList<QByteArray> roles, QString keyField, QObject *parent)
    : QAbstractListModel(parent), m_roles(std::move(roles)), m_key(std::move(keyField)) {}

int JsonListModel::rowCount(const QModelIndex &parent) const {
    return parent.isValid() ? 0 : int(m_rows.size());
}

QVariant JsonListModel::data(const QModelIndex &index, int role) const {
    const int r = index.row();
    const int i = role - Qt::UserRole;
    if (r < 0 || r >= m_rows.size() || i < 0 || i >= m_roles.size()) return {};
    return m_rows.at(r).value(QString::fromLatin1(m_roles.at(i)));
}

QHash<int, QByteArray> JsonListModel::roleNames() const {
    QHash<int, QByteArray> names;
    for (int i = 0; i < m_roles.size(); ++i) names.insert(Qt::UserRole + i, m_roles.at(i));
    return names;
}

QVariantMap JsonListModel::get(int row) const {
    return row >= 0 && row < m_rows.size() ? m_rows.at(row) : QVariantMap{};
}

void JsonListModel::setRows(const QList<QVariantMap> &rows) {
    const int before = int(m_rows.size());

    // 1. Remove rows that are gone (from the end, so indexes stay valid).
    QSet<QString> wanted;
    wanted.reserve(rows.size());
    for (const auto &r : rows) wanted.insert(keyOf(r));
    for (int i = int(m_rows.size()) - 1; i >= 0; --i) {
        if (wanted.contains(keyOf(m_rows.at(i)))) continue;
        int first = i;
        while (first > 0 && !wanted.contains(keyOf(m_rows.at(first - 1)))) --first;
        beginRemoveRows({}, first, i);
        m_rows.remove(first, i - first + 1);
        endRemoveRows();
        i = first;
    }

    // 2. Walk the new order: keep, move, or insert (runs of new rows go in as one insert).
    QSet<QString> have;
    have.reserve(m_rows.size());
    for (const auto &r : m_rows) have.insert(keyOf(r));
    for (int i = 0; i < rows.size(); ++i) {
        const QString k = keyOf(rows.at(i));
        if (i < m_rows.size() && keyOf(m_rows.at(i)) == k) {
            if (m_rows.at(i) != rows.at(i)) {
                m_rows[i] = rows.at(i);
                emit dataChanged(index(i), index(i));
            }
            continue;
        }
        if (!have.contains(k)) {
            int n = 1;
            while (i + n < rows.size() && !have.contains(keyOf(rows.at(i + n)))) ++n;
            beginInsertRows({}, i, i + n - 1);
            for (int j = 0; j < n; ++j) m_rows.insert(i + j, rows.at(i + j));
            endInsertRows();
            i += n - 1;
            continue;
        }
        int from = -1;
        for (int j = i + 1; j < m_rows.size(); ++j)
            if (keyOf(m_rows.at(j)) == k) { from = j; break; }
        if (from < 0) continue;  // duplicate key in the input; skip it
        beginMoveRows({}, from, from, {}, i);
        m_rows.move(from, i);
        endMoveRows();
        if (m_rows.at(i) != rows.at(i)) {
            m_rows[i] = rows.at(i);
            emit dataChanged(index(i), index(i));
        }
    }
    // Duplicate keys in the input can leave extra rows at the end.
    if (m_rows.size() > rows.size()) {
        beginRemoveRows({}, int(rows.size()), int(m_rows.size()) - 1);
        m_rows.resize(rows.size());
        endRemoveRows();
    }
    if (before != m_rows.size()) emit countChanged();
}
