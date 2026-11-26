pragma ComponentBehavior: Bound
import QtQuick
import MessageHub

Rectangle {
    id: c
    property var conversations: []
    property var replyTo: null
    property int picked: 0  // index into conversations; the newest conversation comes first
    readonly property var conv: conversations.length ? conversations[Math.min(picked, conversations.length - 1)] : null
    readonly property int conversationId: conv ? conv.id : 0
    readonly property string serviceName: {
        const s = conv ? conv.lastService : "imessage";
        return s === "whatsapp" ? "WhatsApp" : s === "sms" ? "Text Message" : s === "rcs" ? "Text Message · RCS" : "iMessage";
    }
    signal sent()
    signal cancelReply()

    function focusInput() { input.forceActiveFocus(); }
    function send() {
        const text = input.text.trim();
        if (!text) return;
        Hub.send(text, c.conversationId, c.replyTo ? c.replyTo.id : 0);
        input.clear();
        c.sent();
    }
    onConversationsChanged: picked = 0

    color: Theme.glass ? "transparent" : Theme.bg  // with glass the pane's tint is behind it
    height: col.height + 14

    Rectangle { width: parent.width; height: 1; color: Theme.sep }

    Column {
        id: col
        y: 8
        width: parent.width
        spacing: 6

        // Which service to reply on, when this person has more than one chat.
        Row {
            visible: c.conversations.length > 1
            anchors.horizontalCenter: parent.horizontalCenter
            spacing: 6
            Repeater {
                model: c.conversations
                delegate: Rectangle {
                    id: pill
                    required property var modelData
                    required property int index
                    readonly property bool on: c.picked === index
                    readonly property string label: modelData.network === "whatsapp" ? "WhatsApp" : (modelData.lastService === "imessage" ? "iMessage" : "Text Message")
                    width: pillText.implicitWidth + 20
                    height: 22
                    radius: 11
                    color: on ? (modelData.network === "whatsapp" ? Theme.whatsapp : (modelData.lastService === "imessage" ? Theme.accent : Theme.sms)) : Theme.ctrl
                    Text { id: pillText; anchors.centerIn: parent; text: pill.label; color: pill.on ? "white" : Theme.text2; font.pixelSize: 11; font.family: Theme.boldFont; font.weight: Font.DemiBold }
                    MouseArea { anchors.fill: parent; onClicked: { c.picked = pill.index; c.focusInput(); } }
                }
            }
        }

        Rectangle {
            visible: !!c.replyTo
            x: 52
            width: parent.width - 104
            height: 30
            radius: 8
            color: Theme.ctrl
            Glyph { x: 8; anchors.verticalCenter: parent.verticalCenter; name: "reply"; width: 14; height: 14; color: Theme.text2 }
            Text {
                x: 28
                anchors.verticalCenter: parent.verticalCenter
                width: parent.width - 56
                elide: Text.ElideRight
                text: c.replyTo ? "Replying to " + c.replyTo.name + ": " + (c.replyTo.body || "") : ""
                color: Theme.text2
                font.pixelSize: 12
            }
            Glyph {
                anchors.right: parent.right
                anchors.rightMargin: 8
                anchors.verticalCenter: parent.verticalCenter
                name: "clear"
                width: 14
                height: 14
                color: Theme.text3
                MouseArea { anchors.fill: parent; anchors.margins: -4; onClicked: c.cancelReply() }
            }
        }

        Item {
            width: parent.width
            height: field.height

            Rectangle {
                id: attach
                x: 14
                anchors.bottom: parent.bottom
                anchors.bottomMargin: (34 - height) / 2
                width: 28
                height: 28
                radius: 14
                color: attachMa.containsMouse ? Qt.darker(Theme.ctrl, 1.2) : Theme.ctrl
                Glyph { anchors.centerIn: parent; name: "plus"; width: 14; height: 14; color: Theme.text2; stroke: 1.8 }
                MouseArea { id: attachMa; anchors.fill: parent; hoverEnabled: true; onClicked: Hub.pickFile(c.conversationId) }
            }

            Rectangle {
                id: field
                anchors.left: attach.right
                anchors.leftMargin: 10
                anchors.right: parent.right
                anchors.rightMargin: 14
                height: Math.min(Math.max(34, input.contentHeight + 16), 140)
                radius: 17
                color: "transparent"
                border.width: 1
                border.color: input.activeFocus ? Qt.rgba(Theme.text.r, Theme.text.g, Theme.text.b, 0.25) : Theme.border

                Flickable {
                    id: flick
                    anchors.fill: parent
                    anchors.leftMargin: 14
                    anchors.rightMargin: 38
                    anchors.topMargin: 8
                    anchors.bottomMargin: 8
                    contentWidth: width
                    contentHeight: input.contentHeight
                    clip: true
                    boundsBehavior: Flickable.StopAtBounds
                    function ensureVisible(r) {
                        if (contentY >= r.y) contentY = r.y;
                        else if (contentY + height <= r.y + r.height) contentY = r.y + r.height - height;
                    }
                    TextEdit {
                        id: input
                        width: flick.width
                        wrapMode: TextEdit.Wrap
                        color: Theme.text
                        selectionColor: Theme.accent
                        selectedTextColor: "white"
                        font.pixelSize: 14
                        onCursorRectangleChanged: flick.ensureVisible(cursorRectangle)
                        Keys.onReturnPressed: event => {
                            if (event.modifiers & Qt.ShiftModifier) event.accepted = false;
                            else c.send();
                        }
                        Keys.onEnterPressed: event => c.send()
                        Keys.onEscapePressed: if (c.replyTo) c.cancelReply()
                        Text {
                            text: c.serviceName
                            color: Theme.text3
                            font.pixelSize: 14
                            visible: !input.text && !input.preeditText
                        }
                    }
                }

                Rectangle {
                    anchors.right: parent.right
                    anchors.rightMargin: 4
                    anchors.bottom: parent.bottom
                    anchors.bottomMargin: 4
                    width: 26
                    height: 26
                    radius: 13
                    visible: input.text.trim().length > 0
                    color: c.conv && c.conv.network === "whatsapp" ? Theme.whatsapp : (c.conv && c.conv.lastService !== "imessage" ? Theme.sms : Theme.accent)
                    Glyph { anchors.centerIn: parent; name: "up"; width: 14; height: 14; color: "white"; stroke: 2 }
                    MouseArea { anchors.fill: parent; onClicked: c.send() }
                }
            }
        }
    }
}
