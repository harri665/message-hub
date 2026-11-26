pragma ComponentBehavior: Bound
import QtQuick
import MessageHub

Item {
    id: row
    required property int index
    required property string key
    required property var id
    required property bool fromMe
    required property string kind
    required property string html
    required property string body
    required property bool jumbo
    required property string time
    required property string service
    required property string senderName
    required property bool showName
    required property string separator
    required property bool tail
    required property string statusText
    required property bool failed
    required property bool pending
    required property var attachments
    required property var reactions
    required property string replyName
    required property string replyBody
    required property bool unsent
    required property bool edited
    property bool group: false

    signal replyRequested(var id, string name, string body)
    signal menuRequested(Item item, real x, real y, var entries)

    readonly property real side: 14
    readonly property real indent: group && !fromMe ? 36 : 0
    readonly property real maxBubble: Math.min(width * 0.66, 520)
    readonly property color svcColor: service === "whatsapp" ? Theme.whatsapp : (service === "imessage" ? Theme.accent : Theme.sms)
    readonly property bool hasReactions: reactions && reactions.length > 0

    height: col.height + (tail ? 8 : 2)

    function openMenu(item, x, y) {
        const entries = [];
        if (!row.pending && row.kind !== "system")
            entries.push({ label: "Reply", action: () => row.replyRequested(row.id, row.fromMe ? "You" : row.senderName, row.body) });
        if (row.body) entries.push({ label: "Copy", action: () => Hub.copyText(row.body) });
        for (const a of row.attachments)
            entries.push({ label: "Open " + (a.filename || "Attachment"), action: () => Hub.openAttachment(a.id, a.filename || "") });
        if (entries.length) row.menuRequested(item, x, y, entries);
    }

    Column {
        id: col
        width: parent.width

        Text {
            width: parent.width
            visible: row.separator.length > 0
            horizontalAlignment: Text.AlignHCenter
            topPadding: 14
            bottomPadding: 8
            text: row.separator
            color: Theme.text2
            font.family: Theme.boldFont
            font.weight: Font.DemiBold
            font.pixelSize: 11
        }

        // System notices ("Name named the conversation ...")
        Text {
            width: parent.width
            visible: row.kind === "system"
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.Wrap
            leftPadding: 40
            rightPadding: 40
            topPadding: 4
            bottomPadding: 4
            text: row.body
            color: Theme.text2
            font.pixelSize: 11
        }

        Text {
            x: row.side + row.indent + 12
            visible: row.showName && row.kind !== "system"
            text: row.senderName
            color: Theme.text2
            font.pixelSize: 11
            topPadding: 2
            bottomPadding: 2
        }

        Item {
            id: line
            visible: row.kind !== "system"
            width: parent.width
            height: stack.height + (row.hasReactions ? 12 : 0)

            Avatar {
                x: row.side
                anchors.bottom: parent.bottom
                size: 28
                visible: row.group && !row.fromMe && row.tail
                initials: {
                    const p = row.senderName.replace(/[^\p{L}\p{N}\s]/gu, "").trim().split(/\s+/);
                    return p[0] ? String(p[0][0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase() : "#";
                }
            }

            Column {
                id: stack
                y: row.hasReactions ? 12 : 0
                x: row.fromMe ? parent.width - row.side - width : row.side + row.indent
                width: Math.max(bubble.visible ? bubble.width : 0, atts.width, unsentText.visible ? unsentText.width : 0)
                spacing: 3

                Column {
                    id: atts
                    spacing: 3
                    width: childrenRect.width
                    Repeater {
                        model: row.attachments
                        delegate: Item {
                            id: att
                            required property var modelData
                            readonly property bool isImage: (modelData.mime || "").startsWith("image/")
                            width: loader.width
                            height: loader.height
                            x: row.fromMe ? atts.width - width : 0
                            Loader { id: loader; sourceComponent: att.isImage ? imageAtt : fileAtt }

                    Component {
                        id: imageAtt
                        Item {
                            id: imgItem
                            readonly property var a: att.modelData
                            readonly property real w0: a.width > 0 ? a.width : 0
                            readonly property real h0: a.height > 0 ? a.height : 0
                            readonly property real k: w0 && h0 ? Math.min(1, 240 / w0, 300 / h0) : 1
                            width: w0 && h0 ? Math.max(60, Math.round(w0 * k)) : 220
                            height: w0 && h0 ? Math.max(60, Math.round(h0 * k)) : 220
                            property int attempt: 0
                            Rectangle {
                                anchors.fill: parent
                                radius: 16
                                color: Theme.ctrl
                                visible: photo.status !== Image.Ready
                                Column {
                                    anchors.centerIn: parent
                                    spacing: 6
                                    Glyph { anchors.horizontalCenter: parent.horizontalCenter; name: "photo"; color: Theme.text3; width: 22; height: 22 }
                                    Text {
                                        anchors.horizontalCenter: parent.horizontalCenter
                                        text: photo.status === Image.Error ? "Photo unavailable · Retry" : ""
                                        color: Theme.text2
                                        font.pixelSize: 11
                                    }
                                }
                            }
                            RoundedImage {
                                id: photo
                                anchors.fill: parent
                                radius: 16
                                source: "image://att/" + imgItem.a.id + (imgItem.attempt ? "?retry=" + imgItem.attempt : "")
                            }
                            MouseArea {
                                anchors.fill: parent
                                acceptedButtons: Qt.LeftButton | Qt.RightButton
                                cursorShape: Qt.PointingHandCursor
                                onClicked: mouse => {
                                    if (mouse.button === Qt.RightButton) row.openMenu(imgItem, mouse.x, mouse.y);
                                    else if (photo.status === Image.Error) imgItem.attempt++;
                                    else Hub.openAttachment(imgItem.a.id, imgItem.a.filename || "");
                                }
                            }
                        }
                    }

                    Component {
                        id: fileAtt
                        Rectangle {
                            id: chip
                            readonly property var a: att.modelData
                            width: Math.min(row.maxBubble, Math.max(180, label.implicitWidth + 60))
                            height: 46
                            radius: 14
                            color: row.fromMe ? row.svcColor : Theme.bubbleIn
                            Glyph { x: 12; anchors.verticalCenter: parent.verticalCenter; name: "file"; width: 20; height: 20; color: row.fromMe ? "white" : Theme.text2 }
                            Column {
                                x: 42
                                anchors.verticalCenter: parent.verticalCenter
                                width: parent.width - 54
                                Text { id: label; width: parent.width; elide: Text.ElideMiddle; text: chip.a.filename || "Attachment"; color: row.fromMe ? "white" : Theme.text; font.pixelSize: 13 }
                                Text {
                                    text: {
                                        const n = chip.a.size || 0;
                                        const size = n < 1024 ? (n ? n + " B" : "") : n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB";
                                        const kind = (chip.a.mime || "").split("/")[0];
                                        return [kind === "video" ? "Video" : kind === "audio" ? "Audio" : "File", size].filter(s => s).join(" · ");
                                    }
                                    color: row.fromMe ? Qt.rgba(1, 1, 1, 0.75) : Theme.text2
                                    font.pixelSize: 11
                                }
                            }
                            MouseArea {
                                anchors.fill: parent
                                acceptedButtons: Qt.LeftButton | Qt.RightButton
                                cursorShape: Qt.PointingHandCursor
                                onClicked: mouse => mouse.button === Qt.RightButton ? row.openMenu(chip, mouse.x, mouse.y) : Hub.openAttachment(chip.a.id, chip.a.filename || "")
                            }
                        }
                    }
                        }
                    }
                }

                Rectangle {
                    id: bubble
                    visible: row.body.length > 0 && !row.unsent
                    x: row.fromMe ? stack.width - width : 0
                    readonly property real pad: 12
                    width: Math.min(row.maxBubble, Math.max(msg.implicitWidth + pad * 2, quote.visible ? quote.implicitWidth + pad * 2 : 0, 36))
                    height: inner.height
                    radius: 18
                    color: row.jumbo ? "transparent" : (row.fromMe ? row.svcColor : Theme.bubbleIn)
                    opacity: row.pending && !row.failed ? 0.7 : 1

                    Column {
                        id: inner
                        width: parent.width
                        topPadding: row.jumbo ? 0 : 7
                        bottomPadding: row.jumbo ? 0 : 7

                        Item {
                            id: quote
                            visible: row.replyBody.length > 0
                            width: parent.width
                            height: visible ? quoteCol.height + 6 : 0
                            implicitWidth: Math.min(row.maxBubble - 24, Math.max(quoteName.implicitWidth, quoteBody.implicitWidth) + 12)
                            Rectangle { x: bubble.pad; width: 2; height: quoteCol.height; radius: 1; color: row.fromMe ? Qt.rgba(1, 1, 1, 0.6) : Theme.text3 }
                            Column {
                                id: quoteCol
                                x: bubble.pad + 8
                                width: parent.width - bubble.pad * 2 - 8
                                Text { id: quoteName; text: row.replyName; color: row.fromMe ? Qt.rgba(1, 1, 1, 0.85) : Theme.text2; font.pixelSize: 11; font.family: Theme.boldFont; font.weight: Font.DemiBold; elide: Text.ElideRight; width: parent.width }
                                Text { id: quoteBody; text: row.replyBody; color: row.fromMe ? Qt.rgba(1, 1, 1, 0.75) : Theme.text2; font.pixelSize: 12; elide: Text.ElideRight; maximumLineCount: 2; wrapMode: Text.Wrap; width: parent.width }
                            }
                        }

                        Text {
                            id: msg
                            x: row.jumbo ? 0 : bubble.pad
                            width: bubble.width - (row.jumbo ? 0 : bubble.pad * 2)
                            text: row.html
                            textFormat: Text.StyledText
                            wrapMode: Text.Wrap
                            color: row.fromMe ? "white" : Theme.text
                            linkColor: row.fromMe ? "white" : Theme.accent
                            font.pixelSize: row.jumbo ? 40 : 14
                            lineHeight: 1.05
                            onLinkActivated: link => Hub.openLink(link)
                            HoverHandler { cursorShape: msg.hoveredLink ? Qt.PointingHandCursor : Qt.ArrowCursor }
                        }
                        Text {
                            visible: row.edited
                            x: bubble.pad
                            text: "Edited"
                            color: row.fromMe ? Qt.rgba(1, 1, 1, 0.7) : Theme.text2
                            font.pixelSize: 10
                        }
                    }
                    MouseArea {
                        anchors.fill: parent
                        acceptedButtons: Qt.RightButton
                        onClicked: mouse => row.openMenu(bubble, mouse.x, mouse.y)
                    }
                }

                Text {
                    id: unsentText
                    visible: row.unsent
                    x: row.fromMe ? stack.width - width : 0
                    text: (row.fromMe ? "You" : (row.senderName || "They")) + " unsent a message"
                    color: Theme.text3
                    font.italic: true
                    font.pixelSize: 12
                    topPadding: 4
                    bottomPadding: 4
                }
            }

            // Tapbacks / reactions, pinned to the bubble's top corner.
            Row {
                visible: row.hasReactions
                spacing: -4
                x: row.fromMe ? stack.x - width + 14 : stack.x + stack.width - 14
                y: 0
                Repeater {
                    model: row.reactions
                    delegate: Rectangle {
                        required property var modelData
                        width: 24
                        height: 24
                        radius: 12
                        color: modelData.fromMe ? Theme.accent : (Theme.dark ? "#48484A" : "#DCDCE0")
                        border.width: 2
                        border.color: Theme.bg
                        Text { anchors.centerIn: parent; text: parent.modelData.emoji; font.pixelSize: 12 }
                    }
                }
            }
        }

        Text {
            visible: row.statusText.length > 0
            width: parent.width - row.side - 4
            horizontalAlignment: Text.AlignRight
            text: row.failed ? row.statusText + " · Click to Try Again" : row.statusText
            color: row.failed ? Theme.danger : Theme.text2
            font.pixelSize: 11
            font.family: row.failed ? Theme.boldFont : Theme.font
            font.weight: row.failed ? Font.DemiBold : Font.Normal
            topPadding: 3
            MouseArea { anchors.fill: parent; enabled: row.failed; cursorShape: Qt.PointingHandCursor; onClicked: Hub.retry(row.key) }
        }
    }
}
