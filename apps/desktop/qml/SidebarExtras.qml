pragma ComponentBehavior: Bound
import QtQuick
import MessageHub

// Under the search field: the inbox filter (All / Unread / iMessage / WhatsApp), the bar that tells you Claude is
// waiting for approval to send messages, and a quiet row when iMessage or WhatsApp has a problem.
Column {
    id: ex
    spacing: 8
    height: implicitHeight

    // All / Unread / iMessage / WhatsApp, like the web app's segmented control.
    Rectangle {
        x: 12
        width: ex.width - 24
        height: 26
        radius: 8
        color: Theme.ctrl
        Row {
            anchors.fill: parent
            anchors.margins: 2
            Repeater {
                model: [{ key: "all", label: "All" }, { key: "unread", label: "Unread" }, { key: "apple", label: "iMessage" }, { key: "whatsapp", label: "WhatsApp" }]
                delegate: Item {
                    id: seg
                    required property var modelData
                    readonly property bool on: Hub.inboxFilter === modelData.key
                    width: (parent.width) / 4
                    height: parent.height
                    Rectangle {
                        anchors.fill: parent
                        radius: 6
                        color: seg.on ? Theme.ctrlSel : "transparent"
                    }
                    Text {
                        anchors.centerIn: parent
                        text: seg.modelData.label
                        color: seg.on ? Theme.text : Theme.text2
                        font.family: seg.on ? Theme.boldFont : Theme.font
                        font.weight: seg.on ? Font.DemiBold : Font.Normal
                        font.pixelSize: 11
                    }
                    MouseArea { anchors.fill: parent; onClicked: Hub.inboxFilter = seg.modelData.key }
                }
            }
        }
    }

    // Claude's messages waiting for approval: opens the list with Send and Don't send.
    Rectangle {
        x: 12
        width: ex.width - 24
        height: Hub.approvalCount > 0 || Hub.approvals.length > 0 ? 38 : 0
        visible: height > 0
        radius: 10
        color: Qt.rgba(Theme.accent.r, Theme.accent.g, Theme.accent.b, apMa.containsMouse ? 0.30 : 0.22)
        border.width: 1
        border.color: Qt.rgba(Theme.accent.r, Theme.accent.g, Theme.accent.b, 0.55)
        Rectangle {
            x: 12
            anchors.verticalCenter: parent.verticalCenter
            width: 8
            height: 8
            radius: 4
            color: Theme.accent
        }
        Text {
            x: 28
            anchors.verticalCenter: parent.verticalCenter
            width: parent.width - 40
            elide: Text.ElideRight
            text: Hub.approvalCount === 0 ? "A message was not sent"
                : Hub.approvalCount === 1 ? "Claude wants to send a message" : "Claude wants to send " + Hub.approvalCount + " messages"
            color: Theme.text
            font.family: Theme.boldFont
            font.weight: Font.DemiBold
            font.pixelSize: 12
        }
        MouseArea { id: apMa; anchors.fill: parent; hoverEnabled: true; onClicked: Hub.approvalsOpen = true }
    }

    // Connection status: importing, or what is not connected. Click to fix it in the hub's settings.
    Item {
        x: 12
        width: ex.width - 24
        height: Hub.statusText ? Math.max(24, statusLabel.implicitHeight + 10) : 0
        visible: height > 0
        Rectangle {
            anchors.fill: parent
            radius: 8
            color: stMa.containsMouse ? Theme.ctrl : "transparent"
        }
        Rectangle {
            id: stDot
            x: 8
            y: 9
            width: 7
            height: 7
            radius: 3.5
            color: Hub.statusWarn ? "#FF9F0A" : Theme.text3
        }
        Text {
            id: statusLabel
            x: 22
            y: 5
            width: parent.width - 30
            text: Hub.statusText
            color: Theme.text2
            font.pixelSize: 11
            wrapMode: Text.Wrap
        }
        MouseArea { id: stMa; anchors.fill: parent; hoverEnabled: true; enabled: Hub.statusWarn; onClicked: Hub.openHubSettings() }
    }
}
