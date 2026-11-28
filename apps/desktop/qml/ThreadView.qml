pragma ComponentBehavior: Bound
import QtQuick
import MessageHub

Item {
    id: view
    required property Window window
    required property Menu menu
    property var replyTo: null  // { id, name, body }

    readonly property var conversations: Hub.current.conversations ?? []
    readonly property bool open: Hub.currentTid.length > 0
    readonly property bool group: !!Hub.current.isGroup

    function focusComposer() { composer.focusInput(); }

    // Start each conversation at its newest message (also when the window opens on one that is already loaded).
    property string shownTid
    function showNewest() {
        if (Hub.currentTid === shownTid) return;
        shownTid = Hub.currentTid;
        replyTo = null;
        list.positionViewAtBeginning();
    }
    Connections {
        target: Hub
        function onCurrentChanged() { view.showNewest(); }
    }
    Component.onCompleted: Qt.callLater(view.showNewest)

    // With glass, one tint behind the whole pane (header, messages and composer are clear over it).
    Rectangle {
        anchors.fill: parent
        visible: Theme.glass
        color: Theme.bg
    }

    // ---- header ----
    Rectangle {
        id: bar
        width: parent.width
        height: 52
        color: Theme.glass ? "transparent" : Theme.bg
        z: 2
        DragHandler { target: null; onActiveChanged: if (active) view.window.startSystemMove() }
        TapHandler { onDoubleTapped: view.window.visibility === Window.Maximized ? view.window.showNormal() : view.window.showMaximized() }
        Column {
            anchors.centerIn: parent
            visible: view.open
            Text {
                anchors.horizontalCenter: parent.horizontalCenter
                width: Math.min(implicitWidth, bar.width - 40 - (Platform.windowControls === "windows" ? 2 * 100 : 0))
                elide: Text.ElideRight
                text: Hub.current.title ?? ""
                color: Theme.text
                font.family: Theme.boldFont
                font.weight: Font.DemiBold
                font.pixelSize: 13
            }
            Text {
                anchors.horizontalCenter: parent.horizontalCenter
                text: {
                    const names = { imessage: "iMessage", sms: "Text Message", rcs: "RCS", whatsapp: "WhatsApp" };
                    const seen = [];
                    for (const c of view.conversations) {
                        const n = names[c.lastService] ?? c.lastService;
                        if (seen.indexOf(n) < 0) seen.push(n);
                    }
                    return seen.join(" · ");
                }
                visible: text.length > 0
                color: Theme.text2
                font.pixelSize: 11
            }
        }
        Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: Theme.sep }
    }

    Text {
        anchors.centerIn: parent
        visible: !view.open
        text: Hub.threads.count ? "Select a conversation" : ""
        color: Theme.text3
        font.pixelSize: 15
    }

    // ---- messages (newest at the bottom; the list runs bottom-to-top so new rows never shift the view) ----
    ListView {
        id: list
        objectName: "messageList"
        visible: view.open
        anchors.top: bar.bottom
        anchors.bottom: composer.top
        width: parent.width
        clip: true
        model: Hub.messages
        verticalLayoutDirection: ListView.BottomToTop
        reuseItems: true
        cacheBuffer: 800
        boundsBehavior: Flickable.StopAtBounds
        header: Item { width: 1; height: 10 }
        footer: Item {
            width: list.width
            height: 36
            Text {
                anchors.centerIn: parent
                text: Hub.loadingOlder ? "Loading…" : ""
                color: Theme.text3
                font.pixelSize: 11
            }
        }
        // Load older messages when the top of the view gets within a dozen rows of the oldest one loaded
        // (row indexes, not contentY: a bottom-to-top list only estimates the height of rows it hasn't built).
        function maybeLoadOlder() {
            if (!Hub.hasOlder || Hub.loadingOlder || count === 0) return;
            const top = indexAt(width / 2, contentY + 2);
            if (top >= count - 12) Hub.loadOlder();
        }
        onContentYChanged: maybeLoadOlder()
        onCountChanged: Qt.callLater(maybeLoadOlder)

        delegate: MessageRow {
            width: list.width
            group: view.group
            onReplyRequested: (id, name, body) => { view.replyTo = { id: id, name: name, body: body }; composer.focusInput(); }
            onMenuRequested: (item, x, y, entries) => {
                const p = item.mapToItem(view.menu, x, y);
                view.menu.open(p.x, p.y, entries);
            }
        }
    }

    DropArea {
        anchors.fill: list
        enabled: view.open
        onDropped: drop => {
            if (drop.hasUrls) Hub.sendFiles(drop.urls, composer.conversationId);
            drop.accept();
        }
        Rectangle {
            anchors.fill: parent
            anchors.margins: 10
            radius: 12
            visible: parent.containsDrag
            color: Qt.rgba(Theme.accent.r, Theme.accent.g, Theme.accent.b, 0.12)
            border.width: 2
            border.color: Theme.accent
            Text { anchors.centerIn: parent; text: "Drop to send"; color: Theme.accent; font.pixelSize: 15; font.family: Theme.boldFont; font.weight: Font.DemiBold }
        }
    }

    Composer {
        id: composer
        visible: view.open
        anchors.bottom: parent.bottom
        width: parent.width
        conversations: view.conversations
        replyTo: view.replyTo
        onCancelReply: view.replyTo = null
        onSent: view.replyTo = null
    }
}
