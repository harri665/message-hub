import QtQuick
import MessageHub

// Contact picture stand-in: initials on the grey gradient Messages.app uses.
Rectangle {
    id: a
    property string initials: "#"
    property int size: 40
    width: size
    height: size
    radius: size / 2
    gradient: Gradient {
        GradientStop { position: 0; color: Theme.dark ? "#8E8E93" : "#A9ABB3" }
        GradientStop { position: 1; color: Theme.dark ? "#636366" : "#888A92" }
    }
    Text {
        anchors.centerIn: parent
        text: a.initials
        color: "white"
        font.family: Theme.boldFont
        font.pixelSize: Math.round(a.size * 0.4)
        font.weight: Font.DemiBold
    }
}
