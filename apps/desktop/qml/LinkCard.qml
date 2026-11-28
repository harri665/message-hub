import QtQuick
import MessageHub

// A link as iPhone Messages shows it: a card in the bubble's own colour with the page's picture on top and its title and
// site under it, or a compact row (icon, title, site) when there is no picture. The hub supplies everything (see
// Hub.linkPreview); until it answers, or when there is nothing to show, this item stays hidden and the message keeps its
// plain text. While shown, `restHtml` is the message's text without the link, for the text bubble beside the card.
Item {
    id: card

    property var messageId: 0
    property bool wanted: false       // the message has a link and could have a card
    property bool fromMe: false
    property color tint: Theme.bubbleIn
    property real maxWidth: 300
    property bool dimmed: false
    signal menuRequested(real x, real y)

    property var info: ({})
    readonly property bool shown: wanted && info.state === "ok"
    readonly property string restHtml: shown ? Hub.linkHtml(info.rest || "") : ""
    readonly property bool hasImage: shown && !!info.imageSource && photo.status !== Image.Error
    readonly property color fg: fromMe ? "white" : Theme.text
    readonly property color fg2: fromMe ? Qt.rgba(1, 1, 1, 0.72) : Theme.text2
    readonly property real cardWidth: Math.min(300, maxWidth)
    readonly property real photoHeight: info.imageW > 0 ? Math.max(100, Math.round(cardWidth * info.imageH / info.imageW)) : 0
    readonly property string title: info.title || info.siteName || info.host || ""
    readonly property string site: info.host || info.siteName || ""

    function refresh() {
        if (!wanted || !(messageId > 0)) return;
        const v = Hub.linkPreview(messageId);
        if (v.state) info = v;
    }
    onWantedChanged: refresh()
    onMessageIdChanged: refresh()
    Component.onCompleted: { refresh(); }
    Connections {
        target: Hub
        function onLinkPreviewReady(id) { if (id === card.messageId) card.refresh(); }
    }

    visible: shown
    width: shown ? (hasImage ? cardWidth : compact.width) : 0
    height: shown ? (hasImage ? photoHeight + textBlock.height : compact.height) : 0
    opacity: dimmed ? 0.7 : 1

    Rectangle {
        anchors.fill: parent
        radius: 18
        color: card.tint
    }

    // ----- with a picture -----
    Item {
        visible: card.hasImage
        anchors.fill: parent

        RoundedImage {
            id: photo
            width: parent.width
            height: card.photoHeight
            radius: 18
            flatBottom: true
            source: card.shown && card.info.imageSource ? card.info.imageSource : ""
        }
        Column {
            id: textBlock
            y: card.photoHeight
            width: parent.width
            topPadding: 8
            bottomPadding: 10
            spacing: 1
            Text {
                x: 12
                width: parent.width - 24
                text: card.title
                color: card.fg
                font.family: Theme.boldFont
                font.weight: Font.DemiBold
                font.pixelSize: 14
                wrapMode: Text.Wrap
                maximumLineCount: 2
                elide: Text.ElideRight
                lineHeight: 1.05
            }
            Text {
                x: 12
                width: parent.width - 24
                text: card.site
                color: card.fg2
                font.pixelSize: 12
                elide: Text.ElideRight
            }
        }
    }

    // ----- without a picture: icon, title, site -----
    Item {
        id: compact
        visible: card.shown && !card.hasImage
        readonly property real textWidth: Math.max(compactTitle.implicitWidth, compactSite.implicitWidth)
        width: Math.min(card.maxWidth, Math.max(190, 8 + 40 + 10 + textWidth + 14))
        height: 56

        Rectangle {
            id: iconBox
            x: 8
            anchors.verticalCenter: parent.verticalCenter
            width: 40
            height: 40
            radius: 9
            color: card.fromMe ? Qt.rgba(1, 1, 1, 0.2) : Theme.ctrl
            Text {
                anchors.centerIn: parent
                visible: favicon.status !== Image.Ready
                text: (card.site || "?").charAt(0).toUpperCase()
                color: card.fg
                opacity: 0.8
                font.family: Theme.boldFont
                font.weight: Font.DemiBold
                font.pixelSize: 18
            }
            RoundedImage {
                id: favicon
                anchors.fill: parent
                radius: 9
                source: card.shown && !card.hasImage && card.info.iconSource ? card.info.iconSource : ""
            }
        }
        Column {
            x: 58
            width: parent.width - 58 - 14
            anchors.verticalCenter: parent.verticalCenter
            spacing: 1
            Text {
                id: compactTitle
                width: parent.width
                text: card.title
                color: card.fg
                font.family: Theme.boldFont
                font.weight: Font.DemiBold
                font.pixelSize: 14
                wrapMode: Text.Wrap
                maximumLineCount: 2
                elide: Text.ElideRight
                lineHeight: 1.05
            }
            Text {
                id: compactSite
                width: parent.width
                text: card.site
                color: card.fg2
                font.pixelSize: 12
                elide: Text.ElideRight
            }
        }
    }

    MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.LeftButton | Qt.RightButton
        cursorShape: Qt.PointingHandCursor
        onClicked: mouse => {
            if (mouse.button === Qt.RightButton) card.menuRequested(mouse.x, mouse.y);
            else Hub.openLink(card.info.url);
        }
    }
}
