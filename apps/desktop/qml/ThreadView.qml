pragma ComponentBehavior: Bound
import QtQuick
import MessageHub

Item {
    id: view
    objectName: "threadView"
    required property Window window
    required property Menu menu
    property var replyTo: null  // { id, name, body }

    readonly property var conversations: Hub.current.conversations ?? []
    readonly property bool open: Hub.currentTid.length > 0
    readonly property bool group: !!Hub.current.isGroup

    property real flashId: 0
    signal imageRequested(var id)
    Connections {
        target: Hub
        function onRevealRequested(row, id) {
            list.positionViewAtIndex(row, ListView.Center);
            view.flashId = id;
            flashTimer.restart();
        }
    }
    Timer { id: flashTimer; interval: 2000; onTriggered: view.flashId = 0 }

    function focusComposer() { composer.focusInput(); }
    function devSchedule(text) { composer.scheduleRequested(text, composer.conversationId, 0); }  // for `--dev schedule-ui`

    // Start each conversation at its newest message (also when the window opens on one that is already loaded).
    property string shownTid
    function showNewest() {
        if (Hub.currentTid === shownTid) return;
        shownTid = Hub.currentTid;
        replyTo = null;
        list.positionViewAtBeginning();
        list.follow = true;
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
                    if (Hub.scheduled.count > 0) seen.push(Hub.scheduled.count + " scheduled");
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
        // The bottom of the list (the header of a bottom-to-top list): messages waiting to be sent, then a little space.
        header: Column {
            width: list.width
            // Scheduled messages appearing or going away at the bottom must not leave the view scrolled up.
            onHeightChanged: if (list.follow) Qt.callLater(list.positionViewAtBeginning)
            Repeater {
                model: Hub.scheduled
                delegate: ScheduledRow {
                    width: list.width
                    onEditRequested: item => {
                        picker.editId = item.id;
                        picker.title = "Edit Scheduled Message";
                        picker.okLabel = "Save";
                        picker.open(item.text, item.sendMs, true);
                    }
                    onMenuRequested: (item, x, y, entries) => {
                        const p = item.mapToItem(view.menu, x, y);
                        view.menu.open(p.x, p.y, entries);
                    }
                }
            }
            // Someone is typing (or recording a voice message): three dots in a bubble, newest of all.
            Item {
                width: list.width
                height: Hub.typingLabel.length ? typingCol.height + 6 : 0
                visible: height > 0
                Column {
                    id: typingCol
                    x: 14
                    y: 6
                    spacing: 2
                    Text {
                        visible: !!Hub.current.isGroup || Hub.typingAudio
                        x: 12
                        text: Hub.typingLabel
                        color: Theme.text2
                        font.pixelSize: 11
                    }
                    Rectangle {
                        width: 58
                        height: 34
                        radius: 17
                        color: Theme.bubbleIn
                        Row {
                            anchors.centerIn: parent
                            spacing: 5
                            Repeater {
                                model: 3
                                delegate: Rectangle {
                                    id: dot
                                    required property int index
                                    width: 8
                                    height: 8
                                    radius: 4
                                    color: Theme.text2
                                    SequentialAnimation on opacity {
                                        running: Hub.typingLabel.length > 0
                                        loops: Animation.Infinite
                                        PauseAnimation { duration: dot.index * 160 }
                                        NumberAnimation { from: 0.35; to: 1; duration: 320 }
                                        NumberAnimation { from: 1; to: 0.35; duration: 320 }
                                        PauseAnimation { duration: (2 - dot.index) * 160 + 200 }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Item { width: 1; height: 10 }
        }
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
        // True while the view is at the newest messages (updated when the user stops scrolling).
        property bool follow: true
        onMovementEnded: follow = atYBeginning
        onContentYChanged: maybeLoadOlder()
        onCountChanged: Qt.callLater(maybeLoadOlder)

        delegate: MessageRow {
            width: list.width
            group: view.group
            flashId: view.flashId
            onImageRequested: id => view.imageRequested(id)
            onReplyRequested: (id, name, body) => { view.replyTo = { id: id, name: name, body: body }; composer.focusInput(); }
            onMenuRequested: (item, x, y, entries, reactions) => {
                const p = item.mapToItem(view.menu, x, y);
                view.menu.open(p.x, p.y, entries, reactions);
            }
        }
    }

    DropArea {
        anchors.fill: list
        enabled: view.open
        onDropped: drop => {
            if (drop.hasUrls) composer.stage(drop.urls);  // shown in the message box, sent with Send
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
            Text { anchors.centerIn: parent; text: "Drop to add"; color: Theme.accent; font.pixelSize: 15; font.family: Theme.boldFont; font.weight: Font.DemiBold }
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
        onScheduleRequested: (text, convId, replyId) => {
            picker.editId = 0;
            picker.convId = convId;
            picker.replyId = replyId;
            picker.title = "Schedule Message";
            picker.okLabel = "Schedule";
            picker.open(text, 0, false);
        }
    }

    SchedulePicker {
        id: picker
        property real editId: 0
        property int convId: 0
        property int replyId: 0
        onAccepted: (text, ms) => {
            if (editId) Hub.editScheduled(editId, text, ms);
            else Hub.schedule(text, convId, replyId, ms);
        }
        // A new message was scheduled: the composer's box clears and a reply ends. (Edits leave the box alone.)
        onSaved: if (!editId) composer.scheduled()
        onVisibleChanged: if (!visible) view.focusComposer()
    }
}
