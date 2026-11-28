import QtQuick
import MessageHub

Item {
    id: row
    required property string tid
    required property string title
    required property string time
    required property string preview
    required property string initials
    required property string photo  // version of the profile photo, empty when there is none
    required property int unread
    required property string service
    required property bool isGroup
    required property bool muted
    required property bool pinned
    required property bool lastPinned  // the last of the pinned chats: a line parts them from the rest
    required property bool typing
    required property string draft
    signal clicked()
    signal contextRequested(real x, real y)

    readonly property bool selected: Hub.currentTid === tid
    readonly property color fg: selected ? "white" : Theme.text
    readonly property color fg2: selected ? Qt.rgba(1, 1, 1, 0.78) : Theme.text2
    height: lastPinned ? 78 : 68

    Rectangle {
        anchors.fill: parent
        anchors.leftMargin: 8
        anchors.rightMargin: 8
        anchors.bottomMargin: row.lastPinned ? 10 : 0
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
        photo: row.photo.length ? "image://att/avatar/" + row.tid + "?v=" + row.photo : ""
        visible: row.initials.length > 0
    }
    Text {
        id: name
        anchors.left: avatar.visible ? avatar.right : parent.left
        anchors.leftMargin: avatar.visible ? 10 : 28
        anchors.right: pinMark.visible ? pinMark.left : bell.visible ? bell.left : stamp.left
        anchors.rightMargin: pinMark.visible || bell.visible ? 4 : 6
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
    // Pinned to the top of the list
    Glyph {
        id: pinMark
        anchors.right: bell.visible ? bell.left : dot.visible ? dot.left : stamp.left
        anchors.rightMargin: 5
        anchors.verticalCenter: stamp.verticalCenter
        width: 11
        height: 11
        name: "pin"
        color: row.fg2
        visible: row.pinned
    }
    // Typing beats a draft, and a draft beats the last message, as in Messages and WhatsApp.
    Text {
        anchors.left: name.left
        anchors.right: parent.right
        anchors.rightMargin: 20
        anchors.top: name.bottom
        anchors.topMargin: 2
        textFormat: Text.StyledText
        text: row.typing ? "<i>typing…</i>"
            : row.draft.length ? "<font color=\"" + (row.selected ? "white" : Theme.danger) + "\">Draft:</font> " + row.draft.replace(/&/g, "&amp;").replace(/</g, "&lt;")
            : row.preview.replace(/&/g, "&amp;").replace(/</g, "&lt;")
        color: row.typing && !row.selected ? Theme.accent : row.fg2
        font.pixelSize: 12
        wrapMode: Text.Wrap
        maximumLineCount: 2
        elide: Text.ElideRight
        lineHeight: 1.05
    }
    Rectangle {
        anchors.bottom: parent.bottom
        anchors.bottomMargin: row.lastPinned ? 10 : 0
        anchors.left: name.left
        anchors.right: parent.right
        anchors.rightMargin: 8
        height: 1
        color: Theme.sep
        visible: !row.selected && !row.lastPinned
    }
    Rectangle {
        anchors.bottom: parent.bottom
        anchors.bottomMargin: 4
        x: 16
        width: parent.width - 32
        height: 1
        color: Theme.sep
        visible: row.lastPinned
    }
    MouseArea {
        id: ma
        anchors.fill: parent
        hoverEnabled: true
        acceptedButtons: Qt.LeftButton | Qt.RightButton
        onClicked: mouse => mouse.button === Qt.RightButton ? row.contextRequested(mouse.x, mouse.y) : row.clicked()
    }
}
