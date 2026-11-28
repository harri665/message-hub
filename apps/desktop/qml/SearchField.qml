import QtQuick
import MessageHub

Rectangle {
    id: f
    property alias text: input.text
    signal escaped()
    function focusField() { input.forceActiveFocus(); input.selectAll(); }

    height: 30
    radius: 8
    color: Theme.ctrl
    border.width: input.activeFocus ? 2 : 0
    border.color: Qt.rgba(Theme.accent.r, Theme.accent.g, Theme.accent.b, 0.55)

    // Over glass the field floats on the sidebar like a small piece of glass itself.
    GlassEdge {
        anchors.fill: parent
        visible: Theme.glass && !input.activeFocus
        radius: f.radius
        rim: Theme.edgeLight * 0.8
    }

    Glyph {
        id: icon
        name: "search"
        color: Theme.text2
        width: 14
        height: 14
        x: 9
        anchors.verticalCenter: parent.verticalCenter
    }
    TextInput {
        id: input
        anchors.left: icon.right
        anchors.leftMargin: 6
        anchors.right: clear.left
        anchors.rightMargin: 4
        anchors.verticalCenter: parent.verticalCenter
        color: Theme.text
        selectionColor: Theme.accent
        selectedTextColor: "white"
        font.pixelSize: 13
        clip: true
        Keys.onEscapePressed: { text = ""; f.escaped(); }
        Text {
            text: "Search"
            color: Theme.text3
            font.pixelSize: 13
            visible: !input.text && !input.preeditText
        }
    }
    Glyph {
        id: clear
        name: "clear"
        color: Theme.text3
        width: 14
        height: 14
        anchors.right: parent.right
        anchors.rightMargin: 8
        anchors.verticalCenter: parent.verticalCenter
        visible: input.text.length > 0
        MouseArea { anchors.fill: parent; anchors.margins: -4; onClicked: { input.text = ""; f.escaped(); } }
    }
}
