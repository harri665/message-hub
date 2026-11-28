import QtQuick
import MessageHub

Rectangle {
    id: login
    required property Window window
    color: Theme.bg

    function submit() {
        if (!password.text || Hub.busy) return;
        Hub.login(server.text, password.text);
    }
    Connections {
        target: Hub
        function onSignedInChanged() { password.text = ""; }
    }
    onVisibleChanged: if (visible) (server.text ? password : server).editor.forceActiveFocus()
    Component.onCompleted: if (visible) (server.text ? password : server).editor.forceActiveFocus()

    DragHandler { target: null; onActiveChanged: if (active) login.window.startSystemMove() }
    TrafficLights { x: 18; y: 19; window: login.window; visible: Platform.windowControls === "mac" }

    Column {
        anchors.centerIn: parent
        anchors.verticalCenterOffset: -20
        spacing: 12

        RoundedImage {
            anchors.horizontalCenter: parent.horizontalCenter
            source: "qrc:/qt/qml/MessageHub/icon.png"
            width: 88
            height: 88
            radius: 20
        }
        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            text: "Messages"
            color: Theme.text
            font.family: Theme.boldFont
            font.weight: Font.DemiBold
            font.pixelSize: 22
        }
        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            text: "Sign in to your message hub"
            color: Theme.text2
            font.pixelSize: 13
            bottomPadding: 6
        }
        Field {
            id: server
            anchors.horizontalCenter: parent.horizontalCenter
            placeholder: "https://messages.example.com"
            text: Hub.server
            onAccepted: password.editor.forceActiveFocus()
        }
        Field {
            id: password
            anchors.horizontalCenter: parent.horizontalCenter
            placeholder: "Password"
            echoMode: TextInput.Password
            onAccepted: login.submit()
        }
        Rectangle {
            anchors.horizontalCenter: parent.horizontalCenter
            width: 260
            height: 32
            radius: 8
            color: Theme.accent
            opacity: password.text && !Hub.busy ? 1 : 0.5
            Text {
                anchors.centerIn: parent
                text: Hub.busy ? "Signing In…" : "Sign In"
                color: "white"
                font.family: Theme.boldFont
                font.weight: Font.DemiBold
                font.pixelSize: 13
            }
            MouseArea { anchors.fill: parent; onClicked: login.submit() }
        }
        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            width: 260
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.Wrap
            text: Hub.error
            visible: !!Hub.error
            color: Theme.danger
            font.pixelSize: 12
        }
    }
}
