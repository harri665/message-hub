pragma ComponentBehavior: Bound
import QtQuick
import MessageHub

// A small context menu (Reply, Copy...) in MacShell's menu style. open(x, y, items) with items [{ label, action }].
Item {
    id: m
    anchors.fill: parent
    visible: false
    z: 1000
    property var items: []

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
                    width: col.width
                    height: 26
                    radius: 6
                    color: ma.containsMouse ? Theme.accent : "transparent"
                    Text {
                        x: 10
                        anchors.verticalCenter: parent.verticalCenter
                        text: item.modelData.label
                        color: ma.containsMouse ? "white" : Theme.text
                        font.pixelSize: 13
                    }
                    MouseArea {
                        id: ma
                        anchors.fill: parent
                        hoverEnabled: true
                        onClicked: { m.close(); item.modelData.action(); }
                    }
                }
            }
        }
    }
    Keys.onEscapePressed: close()
}
