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

    TrafficLights { x: 18; y: 19; window: side.window }

    // Settings: the window glass option (saved in the app's config), the version and updates.
    Item {
        id: gear
        anchors.right: parent.right
        anchors.rightMargin: 8
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
        anchors.right: gear.left
        anchors.rightMargin: 6
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
        delegate: ThreadRow {
            width: list.width
            onClicked: side.open(tid)
        }
        // Thread rows animate into their new place when a message moves a chat to the top.
        move: Transition { NumberAnimation { properties: "y"; duration: 180; easing.type: Easing.OutCubic } }
        displaced: Transition { NumberAnimation { properties: "y"; duration: 180; easing.type: Easing.OutCubic } }

        Text {
            anchors.centerIn: parent
            visible: list.count === 0 && !side.searching
            text: "No conversations yet"
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
