import QtQuick
import MessageHub

Rectangle {
    id: f
    property alias text: input.text
    property alias echoMode: input.echoMode
    property alias editor: input
    property string placeholder
    signal accepted()

    width: 260
    height: 32
    radius: 8
    color: Theme.ctrl
    border.width: input.activeFocus ? 2 : 1
    border.color: input.activeFocus ? Qt.rgba(Theme.accent.r, Theme.accent.g, Theme.accent.b, 0.55) : Theme.sep

    TextInput {
        id: input
        anchors.fill: parent
        anchors.leftMargin: 10
        anchors.rightMargin: 10
        verticalAlignment: TextInput.AlignVCenter
        color: Theme.text
        selectionColor: Theme.accent
        selectedTextColor: "white"
        font.pixelSize: 13
        clip: true
        onAccepted: f.accepted()
        Text {
            anchors.verticalCenter: parent.verticalCenter
            text: f.placeholder
            color: Theme.text3
            font.pixelSize: 13
            visible: !input.text && !input.preeditText
        }
    }
}
