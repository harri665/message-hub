import QtQuick
import MessageHub

Item {
    id: row
    required property string tid
    required property string title
    required property string time
    required property string preview
    required property string initials
    required property int unread
    required property string service
    required property bool isGroup
    required property bool muted
    signal clicked()

    readonly property bool selected: Hub.currentTid === tid
    readonly property color fg: selected ? "white" : Theme.text
    readonly property color fg2: selected ? Qt.rgba(1, 1, 1, 0.78) : Theme.text2
    height: 68

    Rectangle {
        anchors.fill: parent
        anchors.leftMargin: 8
        anchors.rightMargin: 8
        radius: 10
        color: row.selected ? Theme.accent : (ma.containsMouse ? Theme.ctrl : "transparent")
    }
    // Unread dot
    Rectangle {
        x: 13
        anchors.verticalCenter: parent.verticalCenter
        width: 9
        height: 9
        radius: 4.5
        visible: row.unread > 0
        color: row.selected ? "white" : (row.muted ? Theme.text3 : Theme.accent)
    }
    Avatar {
        id: avatar
        x: 28
        anchors.verticalCenter: parent.verticalCenter
        size: 42
        initials: row.initials
        visible: row.initials.length > 0
    }
    Text {
        id: name
        anchors.left: avatar.visible ? avatar.right : parent.left
        anchors.leftMargin: avatar.visible ? 10 : 28
        anchors.right: bell.visible ? bell.left : stamp.left
        anchors.rightMargin: bell.visible ? 4 : 6
        y: 12
        text: row.title
        color: row.fg
        elide: Text.ElideRight
        font.family: Theme.boldFont
        font.weight: Font.DemiBold
        font.pixelSize: 13
    }
    Text {
        id: stamp
        anchors.right: parent.right
        anchors.rightMargin: 20
        anchors.baseline: name.baseline
        text: row.time
        color: row.fg2
        font.pixelSize: 12
    }
    Rectangle {
        id: dot
        anchors.right: stamp.left
        anchors.rightMargin: 5
        anchors.verticalCenter: stamp.verticalCenter
        width: 6
        height: 6
        radius: 3
        visible: row.service.length > 0
        color: row.selected ? "white" : (row.service === "whatsapp" ? Theme.whatsapp : (row.service === "imessage" ? Theme.accent : Theme.sms))
        border.width: row.selected ? 0 : 0
    }
    // Muted on the phone
    Glyph {
        id: bell
        anchors.right: dot.visible ? dot.left : stamp.left
        anchors.rightMargin: 5
        anchors.verticalCenter: stamp.verticalCenter
        width: 11
        height: 11
        stroke: 1.2
        name: "muted"
        color: row.fg2
        visible: row.muted
    }
    Text {
        anchors.left: name.left
        anchors.right: parent.right
        anchors.rightMargin: 20
        anchors.top: name.bottom
        anchors.topMargin: 2
        text: row.preview
        color: row.fg2
        font.pixelSize: 12
        wrapMode: Text.Wrap
        maximumLineCount: 2
        elide: Text.ElideRight
        lineHeight: 1.05
    }
    Rectangle {
        anchors.bottom: parent.bottom
        anchors.left: name.left
        anchors.right: parent.right
        anchors.rightMargin: 8
        height: 1
        color: Theme.sep
        visible: !row.selected
    }
    MouseArea {
        id: ma
        anchors.fill: parent
        hoverEnabled: true
        onClicked: row.clicked()
    }
}
