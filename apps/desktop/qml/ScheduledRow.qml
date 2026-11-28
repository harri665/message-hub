pragma ComponentBehavior: Bound
import QtQuick
import MessageHub

// One message waiting to be sent by the hub: a dimmed outgoing bubble with a clock and "Sends tomorrow at 9:00 AM".
// A failed one shows the error with Try Again and Discard. Click the bubble (or right-click) for Edit, Send Now and Cancel.
Item {
    id: row
    required property var model
    readonly property string schedState: model.status
    readonly property bool failed: schedState === "failed"
    readonly property bool sending: schedState === "sending"
    readonly property color svcColor: model.service === "whatsapp" ? Theme.whatsapp : (model.service === "imessage" ? Theme.accent : Theme.sms)
    signal editRequested(var item)
    signal menuRequested(Item item, real x, real y, var entries)

    width: 400
    height: bubble.height + note.height + 12

    function openMenu(x, y) {
        if (row.sending) return;
        const entries = [];
        entries.push({ label: row.failed ? "Edit and Rescheduleâ€¦" : "Editâ€¦", action: () => row.editRequested(row.model) });
        entries.push({ label: row.failed ? "Try Again Now" : "Send Now", action: () => Hub.sendScheduledNow(row.model.id) });
        entries.push({ label: row.failed ? "Discard" : "Cancel Sending", action: () => Hub.cancelScheduled(row.model.id) });
        row.menuRequested(bubble, x, y, entries);
    }

    Rectangle {
        id: bubble
        y: 4
        x: parent.width - 14 - width
        readonly property real maxW: Math.min(row.width * 0.7, 520)
        width: Math.min(maxW, Math.max(label.implicitWidth + 24, 36))
        height: label.implicitHeight + 16
        radius: 18
        color: Qt.rgba(row.svcColor.r, row.svcColor.g, row.svcColor.b, row.failed ? 0.18 : 0.45)
        border.width: 1
        border.color: row.failed ? Theme.danger : row.svcColor
        Text {
            id: label
            x: 12
            y: 8
            width: bubble.maxW - 24
            text: row.model.text
            color: row.failed ? Theme.text : "white"
            opacity: row.failed ? 1 : 0.9
            wrapMode: Text.Wrap
            font.pixelSize: 14
            // A short message shrinks the bubble to fit, a long one wraps at the maximum width.
            onImplicitWidthChanged: width = Math.min(implicitWidth, bubble.maxW - 24)
        }
        MouseArea {
            anchors.fill: parent
            acceptedButtons: Qt.LeftButton | Qt.RightButton
            cursorShape: Qt.PointingHandCursor
            onClicked: mouse => row.openMenu(mouse.x, mouse.y)
        }
    }

    Row {
        id: note
        anchors.right: parent.right
        anchors.rightMargin: 18
        anchors.top: bubble.bottom
        anchors.topMargin: 3
        spacing: 5
        height: Math.max(clock.height, statusText.implicitHeight)
        Canvas {
            id: clock
            width: 11
            height: 11
            anchors.verticalCenter: parent.verticalCenter
            property color tint: row.failed ? Theme.danger : Theme.text2
            onTintChanged: requestPaint()
            onPaint: {
                const c = getContext("2d");
                c.reset();
                c.strokeStyle = tint;
                c.lineWidth = 1.3;
                c.lineCap = "round";
                c.beginPath();
                c.arc(5.5, 5.5, 4.6, 0, Math.PI * 2);
                c.moveTo(5.5, 3); c.lineTo(5.5, 5.5); c.lineTo(7.3, 6.6);
                c.stroke();
            }
        }
        Text {
            id: statusText
            anchors.verticalCenter: parent.verticalCenter
            // The error can be long; keep it to the width of the pane.
            width: Math.min(implicitWidth, row.width - 120)
            elide: Text.ElideRight
            text: row.sending ? "Sendingâ€¦"
                : row.failed ? (row.model.error || "Not sent")
                : "Sends " + Hub.sendsLabel(row.model.sendMs) + (row.model.retrying ? " (trying again soon)" : "")
            color: row.failed ? Theme.danger : Theme.text2
            font.pixelSize: 11
            font.family: row.failed ? Theme.boldFont : Theme.font
            font.weight: row.failed ? Font.DemiBold : Font.Normal
        }
        Text {
            visible: row.failed
            anchors.verticalCenter: parent.verticalCenter
            text: "Try Again"
            color: Theme.accent
            font.pixelSize: 11
            font.family: Theme.boldFont
            font.weight: Font.DemiBold
            MouseArea { anchors.fill: parent; anchors.margins: -3; cursorShape: Qt.PointingHandCursor; onClicked: Hub.sendScheduledNow(row.model.id) }
        }
        Text {
            visible: row.failed
            anchors.verticalCenter: parent.verticalCenter
            text: "Discard"
            color: Theme.accent
            font.pixelSize: 11
            MouseArea { anchors.fill: parent; anchors.margins: -3; cursorShape: Qt.PointingHandCursor; onClicked: Hub.cancelScheduled(row.model.id) }
        }
    }
}
