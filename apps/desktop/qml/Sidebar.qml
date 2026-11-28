pragma ComponentBehavior: Bound
import QtQuick
import MessageHub

Rectangle {
    id: side
    required property Window window
    required property Menu menu
    signal opened()
    color: Theme.bar

    readonly property bool searching: Hub.filter.trim().length > 0
    function focusSearch() { search.focusField(); }
    function open(tid) { Hub.openThread(tid); side.opened(); }
    // Alt+Up / Alt+Down: next or previous conversation.
    function step(d) {
        const n = Hub.threads.count;
        if (!n) return;
        let i = -1;
        for (let k = 0; k < n; ++k) if (Hub.threads.get(k).tid === Hub.currentTid) { i = k; break; }
        i = Math.max(0, Math.min(n - 1, i + d));
        open(Hub.threads.get(i).tid);
        list.positionViewAtIndex(i, ListView.Contain);
    }

    DragHandler { target: null; onActiveChanged: if (active) side.window.startSystemMove() }

    TrafficLights { x: 18; y: 19; window: side.window; visible: Platform.windowControls === "mac" }

    // Settings: the window glass option (saved in the app's config), the version and updates.
    Item {
        id: gear
        // Without traffic lights the top-left is free: the gear takes it, clear of the window buttons on the right.
        x: Platform.windowControls === "mac" ? side.width - width - 8 : 12
        y: 12
        width: 26
        height: 26
        Rectangle {
            anchors.fill: parent
            radius: 6
            color: gearMa.containsMouse ? Theme.ctrl : "transparent"
        }
        Glyph {
            anchors.centerIn: parent
            name: "gear"
            width: 15
            height: 15
            stroke: 1.4
            color: gearMa.containsMouse ? Theme.text : Theme.text2
        }
        // An update is downloaded and waiting: a dot on the gear, as on MacShell's settings.
        Rectangle {
            x: parent.width - 8
            y: 2
            width: 7
            height: 7
            radius: 3.5
            color: Theme.accent
            visible: Updater.state === "ready"
        }
        MouseArea {
            id: gearMa
            anchors.fill: parent
            hoverEnabled: true
            onClicked: side.openSettings()
        }
    }
    function openSettings() {
        const p = gear.mapToItem(side.menu, 0, gear.height + 4);
        const set = mode => () => { Theme.glassMode = mode; };
        const items = [
            { label: "Window glass", header: true },
            { label: "Automatic", detail: Theme.hasShell ? (Theme.shellGlass ? "MacShell: on" : "MacShell: off") : (Theme.autoGlass ? "On" : "Off"), checked: Theme.glassMode === "auto", action: set("auto") },
            { label: "On", checked: Theme.glassMode === "on", action: set("on") },
            { label: "Off", checked: Theme.glassMode === "off", action: set("off") },
            { label: "Messages " + Updater.version, header: true }
        ];
        if (Updater.enabled) items.push(side.updateItem());
        // Closing the window keeps the app running for notifications; this ends it for real (Ctrl+Q does the same).
        items.push({ label: "Force Quit", detail: "Ctrl+Q", action: () => App.quit() });
        side.menu.open(p.x, p.y, items);
    }
    function updateItem() {
        switch (Updater.state) {
        case "ready": return { label: "Restart to Update", detail: Updater.available, action: () => Updater.restartNow() };
        case "downloading": return { label: "Downloading Update…", detail: Updater.progress + "%", action: () => {} };
        case "checking": return { label: "Checking for Updates…", action: () => {} };
        default: return { label: "Check for Updates", detail: Updater.state === "current" ? "Up to date" : Updater.state === "error" ? "Couldn't check" : "", action: () => Updater.check() };
        }
    }

    // Connection state: a quiet dot, as in MacShell's menus.
    Row {
        x: Platform.windowControls === "mac" ? gear.x - 6 - width : gear.x + gear.width + 8
        y: 18
        spacing: 6
        visible: !Hub.online
        Rectangle { width: 7; height: 7; radius: 3.5; color: "#FF9F0A"; anchors.verticalCenter: parent.verticalCenter }
        Text { text: "Connecting…"; color: Theme.text2; font.pixelSize: 11 }
    }

    SearchField {
        id: search
        x: 12
        y: 48
        width: parent.width - 24
        text: Hub.filter
        onTextChanged: Hub.filter = text
        onEscaped: side.forceActiveFocus()
    }

    ListView {
        id: list
        x: 0
        y: search.y + search.height + 10
        width: parent.width
        height: parent.height - y
        clip: true
        model: Hub.threads
        reuseItems: true
        cacheBuffer: 400
        boundsBehavior: Flickable.StopAtBounds
        footer: side.searching ? resultsFooter : null
        // The Archived row (inbox) or the way back (archived list); hidden while searching.
        header: Item {
            width: list.width
            height: !side.searching && (Hub.showArchived || Hub.archivedCount > 0) ? 44 : 0
            visible: height > 0
            Rectangle {
                anchors.fill: parent
                anchors.leftMargin: 8
                anchors.rightMargin: 8
                radius: 10
                color: archMa.containsMouse ? Theme.ctrl : "transparent"
            }
            Glyph {
                x: 22
                anchors.verticalCenter: parent.verticalCenter
                name: Hub.showArchived ? "back" : "archive"
                width: 16
                height: 16
                stroke: 1.5
                color: Theme.text2
            }
            Text {
                x: 50
                anchors.verticalCenter: parent.verticalCenter
                text: "Archived"
                color: Theme.text
                font.family: Theme.boldFont
                font.weight: Font.DemiBold
                font.pixelSize: 13
            }
            Text {
                anchors.right: parent.right
                anchors.rightMargin: 22
                anchors.verticalCenter: parent.verticalCenter
                visible: !Hub.showArchived
                text: (Hub.archivedUnread > 0 ? Hub.archivedUnread + " unread  " : "") + Hub.archivedCount
                color: Theme.text2
                font.pixelSize: 12
            }
            MouseArea {
                id: archMa
                anchors.fill: parent
                hoverEnabled: true
                onClicked: Hub.setShowArchived(!Hub.showArchived)
            }
        }
        delegate: ThreadRow {
            id: threadRow
            width: list.width
            onClicked: side.open(tid)
            onContextRequested: (x, y) => {
                const p = threadRow.mapToItem(side.menu, x, y);
                const archived = Hub.showArchived;
                side.menu.open(p.x, p.y, [{ label: archived ? "Unarchive" : "Archive", action: () => Hub.archiveThread(threadRow.tid, !archived) }]);
            }
        }
        // Thread rows animate into their new place when a message moves a chat to the top.
        move: Transition { NumberAnimation { properties: "y"; duration: 180; easing.type: Easing.OutCubic } }
        displaced: Transition { NumberAnimation { properties: "y"; duration: 180; easing.type: Easing.OutCubic } }

        Text {
            anchors.centerIn: parent
            visible: list.count === 0 && !side.searching
            text: Hub.showArchived ? "No archived conversations" : "No conversations yet"
            color: Theme.text3
            font.pixelSize: 13
        }
    }

    Component {
        id: resultsFooter
        Column {
            width: list.width
            Text {
                x: 18
                topPadding: 14
                bottomPadding: 6
                text: Hub.results.count ? "Messages" : "No messages found"
                color: Theme.text2
                font.family: Theme.boldFont
                font.weight: Font.DemiBold
                font.pixelSize: 11
            }
            Repeater {
                model: Hub.results
                delegate: ThreadRow {
                    width: list.width
                    onClicked: side.open(tid)
                }
            }
        }
    }
}
