pragma ComponentBehavior: Bound
import QtQuick
import MessageHub

Rectangle {
    id: side
    required property Window window
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

    // Connection state: a quiet dot, as in MacShell's menus.
    Row {
        anchors.right: parent.right
        anchors.rightMargin: 14
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
