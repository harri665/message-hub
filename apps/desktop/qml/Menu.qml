pragma ComponentBehavior: Bound
import QtQuick
import MessageHub

// A small context menu (Reply, Copy...) in MacShell's menu style. open(x, y, items) with items [{ label, action }].
Item {
    id: m
    anchors.fill: parent
    visible: false
    z: 1000
    property var items: []  // [{ label, action, checked?, detail? }] or { label, header: true } for a section title
    readonly property bool checks: items.some(i => i.checked !== undefined)

    function open(px, py, list) {
        items = list;
        visible = true;
        panel.x = Math.min(px, width - panel.width - 8);
        panel.y = Math.min(py, height - panel.height - 8);
    }
    function close() { visible = false; }

    MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.AllButtons
        onPressed: m.close()
        onWheel: m.close()
    }
    Rectangle {
        id: panel
        width: 180
        height: col.height + 10
        radius: 10
        color: Theme.dark ? Qt.rgba(0.17, 0.17, 0.18, 0.97) : Qt.rgba(0.97, 0.97, 0.98, 0.98)
        border.width: 1
        border.color: Theme.border
        Column {
            id: col
            x: 5
            y: 5
            width: parent.width - 10
            Repeater {
                model: m.items
                delegate: Rectangle {
                    id: item
                    required property var modelData
                    readonly property bool header: !!modelData.header
                    readonly property bool hot: ma.containsMouse && !header
                    width: col.width
                    height: header ? 22 : 26
                    radius: 6
                    color: hot ? Theme.accent : "transparent"
                    Glyph {
                        x: 8
                        anchors.verticalCenter: parent.verticalCenter
                        visible: !!item.modelData.checked
                        name: "check"
                        width: 11
                        height: 11
                        stroke: 1.7
                        color: item.hot ? "white" : Theme.text
                    }
                    Text {
                        x: m.checks ? 24 : 10
                        anchors.verticalCenter: parent.verticalCenter
                        text: item.modelData.label
                        color: item.header ? Theme.text2 : item.hot ? "white" : Theme.text
                        font.pixelSize: item.header ? 11 : 13
                        font.family: item.header ? Theme.boldFont : Theme.font
                        font.weight: item.header ? Font.DemiBold : Font.Normal
                    }
                    Text {
                        anchors.right: parent.right
                        anchors.rightMargin: 10
                        anchors.verticalCenter: parent.verticalCenter
                        visible: text.length > 0
                        text: item.modelData.detail ?? ""
                        color: item.hot ? Qt.rgba(1, 1, 1, 0.8) : Theme.text3
                        font.pixelSize: 11
                    }
                    MouseArea {
                        id: ma
                        anchors.fill: parent
                        hoverEnabled: true
                        onClicked: if (!item.header) { m.close(); item.modelData.action(); }
                    }
                }
            }
        }
    }
    Keys.onEscapePressed: close()
}
