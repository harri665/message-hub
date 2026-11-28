import QtQuick
import MessageHub

Rectangle {
    id: f
    property alias text: input.text
    signal escaped()
    function focusField() { input.forceActiveFocus(); input.selectAll(); }

    // Suggestions for "from:", "has:" and the other filters, like Discord's search. Arrow keys pick, Enter or Tab completes, Esc closes.
    property bool dismissed: false
    property int active: 0
    property var completion: ({})
    function refresh() {
        completion = (!input.activeFocus || dismissed) ? ({}) : input.text ? SearchAssist.complete(input.text, input.cursorPosition) : SearchAssist.operators();
        active = 0;
    }
    readonly property var choices: completion.items ? completion.items.filter(i => !i.info) : []
    readonly property bool popupOpen: choices.length > 0
    function apply(it) {
        const t = input.text;
        const at = completion.start + it.insert.length;
        input.text = t.slice(0, completion.start) + it.insert + t.slice(completion.end);
        input.cursorPosition = at;
        dismissed = false;
        refresh();
    }
    Connections {
        target: input
        function onTextChanged() { f.dismissed = false; f.refresh(); }
        function onCursorPositionChanged() { f.refresh(); }
        function onActiveFocusChanged() { f.dismissed = false; f.refresh(); }
    }

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
        Keys.onPressed: event => {
            if (!f.popupOpen) return;
            if (event.key === Qt.Key_Down || event.key === Qt.Key_Up) {
                f.active = (f.active + (event.key === Qt.Key_Down ? 1 : -1) + f.choices.length) % f.choices.length;
                event.accepted = true;
            } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter || event.key === Qt.Key_Tab) {
                f.apply(f.choices[f.active]);
                event.accepted = true;
            }
        }
        // Key-specific handlers run before Keys.onPressed, so Esc closes the suggestions first and clears the box on the next press.
        Keys.onEscapePressed: {
            if (f.popupOpen) { f.dismissed = true; f.refresh(); }
            else { text = ""; f.escaped(); }
        }
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

    Rectangle {
        id: popup
        visible: f.popupOpen || (!!f.completion.items && f.completion.items.length > 0)
        z: 100
        y: f.height + 4
        width: f.width
        height: sug.height + 8
        radius: 10
        color: Theme.card
        border.width: 1
        border.color: Theme.border
        GlassEdge { anchors.fill: parent; visible: Theme.glass; radius: popup.radius; rim: Theme.edgeLight * 0.8 }
        Column {
            id: sug
            x: 4
            y: 4
            width: parent.width - 8
            Repeater {
                model: f.completion.items ? f.completion.items : []
                delegate: Rectangle {
                    id: row
                    required property var modelData
                    readonly property int idx: f.choices.findIndex(i => i.label === modelData.label && i.insert === modelData.insert)
                    width: sug.width
                    height: modelData.info ? 24 : 28
                    radius: 7
                    color: idx === f.active ? Qt.rgba(Theme.accent.r, Theme.accent.g, Theme.accent.b, 0.3) : "transparent"
                    Text {
                        id: lbl
                        x: 8
                        anchors.verticalCenter: parent.verticalCenter
                        text: row.modelData.label
                        color: row.modelData.info ? Theme.text2 : Theme.text
                        font.pixelSize: row.modelData.info ? 11 : 13
                        font.family: Theme.boldFont
                        font.weight: row.modelData.info ? Font.Normal : Font.DemiBold
                    }
                    Text {
                        anchors.left: lbl.right
                        anchors.leftMargin: 8
                        anchors.right: parent.right
                        anchors.rightMargin: 6
                        anchors.verticalCenter: parent.verticalCenter
                        elide: Text.ElideRight
                        text: row.modelData.hint
                        color: Theme.text2
                        font.pixelSize: 11
                    }
                    MouseArea {
                        anchors.fill: parent
                        enabled: !row.modelData.info
                        hoverEnabled: true
                        onEntered: f.active = row.idx
                        onClicked: { f.apply(row.modelData); input.forceActiveFocus(); }
                    }
                }
            }
        }
    }
}
