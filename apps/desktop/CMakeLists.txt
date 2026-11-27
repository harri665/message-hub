cmake_minimum_required(VERSION 3.21)
project(message-hub-desktop VERSION 1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# The release version (CI passes the tag's version, e.g. -DMESSAGE_HUB_VERSION=1.3.0); shown in the settings menu.
set(MESSAGE_HUB_VERSION "0.0.0-dev" CACHE STRING "Version shown in the app")
# Automatic updates with Velopack, for the release packages (Windows installer, Linux AppImage). Needs the Velopack
# C/C++ library (velopack_libc_<version>.zip from https://github.com/velopack/velopack/releases) unpacked at VELOPACK_DIR.
option(MESSAGE_HUB_UPDATER "Build in automatic updates (Velopack)" OFF)
set(VELOPACK_DIR "" CACHE PATH "Unpacked velopack_libc release (include/, lib/, lib-static/)")

if(WIN32)
  # The tray icon and the native file dialog are Qt Widgets.
  find_package(Qt6 6.5 REQUIRED COMPONENTS Quick Network WebSockets ShaderTools Widgets)
  set(PLATFORM_SOURCES src/platform_windows.cpp packaging/message-hub.rc)
else()
  find_package(Qt6 6.5 REQUIRED COMPONENTS Quick Network WebSockets ShaderTools DBus)
  set(PLATFORM_SOURCES src/platform_linux.cpp)
endif()
qt_standard_project_setup(REQUIRES 6.5)

qt_add_executable(message-hub
  src/main.cpp
  src/app.h
  src/hub.h src/hub.cpp
  src/theme.h src/theme.cpp
  src/listmodel.h src/listmodel.cpp
  src/platform.h
  src/updater.h src/updater.cpp
  ${PLATFORM_SOURCES}
)
set_target_properties(message-hub PROPERTIES WIN32_EXECUTABLE ON)
target_compile_definitions(message-hub PRIVATE MESSAGE_HUB_VERSION="${MESSAGE_HUB_VERSION}")

# The app icon (shown on the sign-in screen) comes from the web app's icons.
set_source_files_properties(../web/public/icons/icon-192.png PROPERTIES QT_RESOURCE_ALIAS icon.png)

# QML is compiled to C++ at build time (qmlsc), so the window starts without parsing anything.
qt_add_qml_module(message-hub
  URI MessageHub
  VERSION 1.0
  QML_FILES
    qml/Main.qml
    qml/Login.qml
    qml/Sidebar.qml
    qml/ThreadRow.qml
    qml/ThreadView.qml
    qml/MessageRow.qml
    qml/Composer.qml
    qml/Avatar.qml
    qml/TrafficLights.qml
    qml/SearchField.qml
    qml/Field.qml
    qml/Glyph.qml
    qml/RoundedImage.qml
    qml/Menu.qml
  RESOURCES
    ../web/public/icons/icon-192.png
)

qt_add_shaders(message-hub "shaders"
  PREFIX "/"
  FILES shaders/roundedimage.frag
)

# Open Runde (SIL OFL, see fonts/OpenRunde-LICENSE.txt), MacShell's UI font, so the app looks the same without MacShell.
qt_add_resources(message-hub "fonts"
  PREFIX "/fonts"
  BASE fonts
  FILES fonts/OpenRunde-Regular.otf fonts/OpenRunde-Semibold.otf
)

target_include_directories(message-hub PRIVATE src)
target_link_libraries(message-hub PRIVATE Qt6::Quick Qt6::Network Qt6::WebSockets)
if(WIN32)
  target_link_libraries(message-hub PRIVATE Qt6::Widgets dwmapi)
else()
  target_link_libraries(message-hub PRIVATE Qt6::DBus)
endif()

if(MESSAGE_HUB_UPDATER)
  if(NOT EXISTS "${VELOPACK_DIR}/include/Velopack.hpp")
    message(FATAL_ERROR "MESSAGE_HUB_UPDATER needs VELOPACK_DIR pointing at an unpacked velopack_libc release")
  endif()
  target_compile_definitions(message-hub PRIVATE MESSAGE_HUB_UPDATER)
  target_include_directories(message-hub PRIVATE "${VELOPACK_DIR}/include")
  if(WIN32)
    # The DLL goes next to message-hub.exe under the name its import library expects (velopack_libc.dll).
    target_link_libraries(message-hub PRIVATE "${VELOPACK_DIR}/lib/velopack_libc_win_x64_msvc.dll.lib")
    add_custom_command(TARGET message-hub POST_BUILD COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${VELOPACK_DIR}/lib/velopack_libc_win_x64_msvc.dll" "$<TARGET_FILE_DIR:message-hub>/velopack_libc.dll")
  else()
    # Linked in statically, so the AppImage has no extra library to find.
    target_link_libraries(message-hub PRIVATE "${VELOPACK_DIR}/lib-static/velopack_libc_linux_x64_gnu.a" pthread dl m)
  endif()
endif()

if(WIN32)
  return()  # Windows is packaged by CI (windeployqt + Velopack); there is nothing to install by hand
endif()

include(GNUInstallDirs)
# The launcher entry points at the installed binary, so it works even when ~/.local/bin isn't on the session's PATH.
configure_file(message-hub.desktop.in message-hub.desktop @ONLY)
install(TARGETS message-hub RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
install(FILES ${CMAKE_CURRENT_BINARY_DIR}/message-hub.desktop DESTINATION ${CMAKE_INSTALL_DATADIR}/applications)
install(FILES ../web/public/icons/icon-512.png DESTINATION ${CMAKE_INSTALL_DATADIR}/icons/hicolor/512x512/apps RENAME message-hub.png)
install(FILES ../web/public/icons/icon-192.png DESTINATION ${CMAKE_INSTALL_DATADIR}/icons/hicolor/192x192/apps RENAME message-hub.png)
