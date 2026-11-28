pragma ComponentBehavior: Bound
import QtQuick
import MessageHub

// The list of messages Claude asked to send. Nothing is sent until you choose Send here.
Item {
    id: p
    anchors.fill: parent
    visible: Hub.approvalsOpen
    z: 900

    MouseArea { anchors.fill: parent; onClicked: Hub.approvalsOpen = false }  // click outside closes
    Rectangle { anchors.fill: parent; color: Qt.rgba(0, 0, 0, Theme.dark ? 0.45 : 0.25) }
    Shortcut { sequence: "Escape"; enabled: p.visible; onActivated: Hub.approvalsOpen = false }

    Rectangle {
        id: card
        anchors.centerIn: parent
        width: Math.min(480, p.width - 48)
        height: Math.min(head.height + flick.contentHeight + 42, p.height - 80)
        radius: 14
        color: Theme.dark ? Qt.rgba(0.17, 0.17, 0.18, 0.98) : Qt.rgba(0.97, 0.97, 0.98, 0.99)
        border.width: 1
        border.color: Theme.border
        MouseArea { anchors.fill: parent }  // clicks on the card don't close it

        Column {
            id: head
            x: 18
            y: 16
            width: parent.width - 36
            spacing: 3
            Text {
                width: parent.width
                text: Hub.approvalCount === 0 ? "Message not sent"
                    : Hub.approvalCount === 1 ? "Claude wants to send a message" : "Claude wants to send " + Hub.approvalCount + " messages"
                color: Theme.text
                font.family: Theme.boldFont
                font.weight: Font.DemiBold
                font.pixelSize: 15
                wrapMode: Text.Wrap
            }
            Text {
                visible: Hub.approvalCount > 0
                text: "Nothing is sent until you choose Send."
                color: Theme.text2
                font.pixelSize: 12
            }
        }

        Flickable {
            id: flick
            x: 18
            y: head.y + head.height + 10
            width: parent.width - 36
            height: parent.height - y - 14
            contentHeight: list.height
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            Column {
                id: list
                width: flick.width
                spacing: 10
                Repeater {
                    model: Hub.approvals
                    delegate: Rectangle {
                        id: req
                        required property var modelData
                        width: list.width
                        height: body.height + 24
                        radius: 10
                        color: Theme.ctrl
                        Column {
                            id: body
                            x: 12
                            y: 12
                            width: parent.width - 24
                            spacing: 6
                            Text {
                                width: parent.width
                                text: "To " + req.modelData.title
                                color: Theme.text
                                font.family: Theme.boldFont
                                font.weight: Font.DemiBold
                                font.pixelSize: 13
                                elide: Text.ElideRight
                            }
                            Text {
                                width: parent.width
                                text: req.modelData.service + ", asked " + req.modelData.when + (req.modelData.requestedBy ? " by " + req.modelData.requestedBy : "")
                                color: Theme.text2
                                font.pixelSize: 11
                                wrapMode: Text.Wrap
                            }
                            Text {
                                width: parent.width
                                visible: !!req.modelData.replyText
                                text: req.modelData.replyText
                                color: Theme.text2
                                font.pixelSize: 11
                                font.italic: true
                                wrapMode: Text.Wrap
                                maximumLineCount: 3
                                elide: Text.ElideRight
                            }
                            Text {
                                width: parent.width
                                text: req.modelData.text
                                color: Theme.text
                                font.pixelSize: 13
                                wrapMode: Text.Wrap
                                textFormat: Text.PlainText
                            }
                            Text {
                                width: parent.width
                                visible: !!req.modelData.error
                                text: req.modelData.error
                                color: Theme.danger
                                font.pixelSize: 12
                                wrapMode: Text.Wrap
                            }
                            Row {
                                layoutDirection: Qt.RightToLeft
                                width: parent.width
                                spacing: 8
                                Rectangle {
                                    visible: !req.modelData.failed
                                    width: sendLabel.implicitWidth + 28
                                    height: 28
                                    radius: 14
                                    color: Theme.accent
                                    opacity: req.modelData.busy ? 0.5 : (sendMa.containsMouse ? 0.85 : 1)
                                    Text { id: sendLabel; anchors.centerIn: parent; text: req.modelData.busy ? "Sending" : "Send"; color: "white"; font.family: Theme.boldFont; font.weight: Font.DemiBold; font.pixelSize: 12 }
                                    MouseArea { id: sendMa; anchors.fill: parent; hoverEnabled: true; enabled: !req.modelData.busy; onClicked: Hub.approveSend(req.modelData.id) }
                                }
                                Rectangle {
                                    width: rejectLabel.implicitWidth + 28
                                    height: 28
                                    radius: 14
                                    color: rejectMa.containsMouse ? Theme.ctrlSel : Theme.ctrl
                                    border.width: 1
                                    border.color: Theme.border
                                    opacity: req.modelData.busy ? 0.5 : 1
                                    Text { id: rejectLabel; anchors.centerIn: parent; text: req.modelData.failed ? "Dismiss" : "Don't send"; color: Theme.text; font.pixelSize: 12 }
                                    MouseArea { id: rejectMa; anchors.fill: parent; hoverEnabled: true; enabled: !req.modelData.busy; onClicked: Hub.rejectSend(req.modelData.id) }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
