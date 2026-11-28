#include "updater.h"

#include <QCoreApplication>
#include <QJSEngine>
#include <QPointer>
#include <QThread>

#include <chrono>
#include <cstdlib>
#include <thread>

#include "platform.h"

#ifdef MESSAGE_HUB_UPDATER
#include <Velopack.hpp>
#include <optional>
#endif

namespace {
constexpr const char *kRepo = "https://github.com/harri665/message-hub";
}

struct Updater::Private {
#ifdef MESSAGE_HUB_UPDATER
    std::unique_ptr<Velopack::UpdateManager> manager;
    std::optional<Velopack::VelopackAsset> pending;  // downloaded, waiting to be installed
#endif
    bool busy = false;
};

void Updater::startup() {
#ifdef MESSAGE_HUB_UPDATER
    try {
        // Start at login so notifications keep coming (the stub path stays the same across updates); the uninstaller
        // takes it out again. These hooks only run on Windows; on Linux Velopack calls neither.
        Velopack::VelopackApp::Build()
            .OnAfterInstall([](void *, const char *) { Platform::setAutostart(true); })
            .OnBeforeUninstall([](void *, const char *) { Platform::setAutostart(false); })
            .Run();
    } catch (const std::exception &e) {
        qWarning("message-hub: update startup: %s", e.what());
    }
#endif
}

Updater *Updater::instance() {
    static Updater *u = new Updater;
    return u;
}

Updater *Updater::create(QQmlEngine *, QJSEngine *) {
    QJSEngine::setObjectOwnership(instance(), QJSEngine::CppOwnership);
    return instance();
}

Updater::Updater() : d(std::make_unique<Private>()), m_version(QStringLiteral(MESSAGE_HUB_VERSION)) {
#ifdef MESSAGE_HUB_UPDATER
    try {
        d->manager = std::make_unique<Velopack::UpdateManager>(std::make_unique<Velopack::GithubSource>(kRepo));
        m_version = QString::fromStdString(d->manager->GetCurrentVersion()).trimmed();
        m_version.remove(QChar('\0'));
        // An update downloaded by an earlier run that was never installed.
        if (auto asset = d->manager->UpdatePendingRestart()) {
            d->pending = asset;
            m_available = QString::fromStdString(asset->Version);
            m_state = QStringLiteral("ready");
        }
    } catch (const std::exception &) {
        d->manager.reset();  // not installed from a release package (e.g. built from source): no updates
    }
#endif
    if (!enabled()) return;
    m_timer.setInterval(6 * 60 * 60 * 1000);
    connect(&m_timer, &QTimer::timeout, this, &Updater::check);
    m_timer.start();
    QTimer::singleShot(60 * 1000, this, &Updater::check);
}

Updater::~Updater() = default;

bool Updater::enabled() const {
#ifdef MESSAGE_HUB_UPDATER
    return d->manager != nullptr;
#else
    return false;
#endif
}

void Updater::setState(const QString &s, int progress) {
    if (s == m_state && progress == m_progress) return;
    m_state = s;
    m_progress = progress;
    emit changed();
}

void Updater::check() {
#ifdef MESSAGE_HUB_UPDATER
    if (!enabled() || d->busy || ready()) return;
    d->busy = true;
    setState("checking");
    Velopack::UpdateManager *manager = d->manager.get();
    QPointer<Updater> self(this);
    // Checking and downloading block, so they run on a worker thread and report back to this one.
    QThread *t = QThread::create([manager, self] {
        auto post = [self](std::function<void(Updater *)> f) {
            QMetaObject::invokeMethod(qApp, [self, f] { if (self) f(self); }, Qt::QueuedConnection);
        };
        try {
            const std::optional<Velopack::UpdateInfo> info = manager->CheckForUpdates();
            if (!info) {
                post([](Updater *u) { u->d->busy = false; u->setState("current"); });
                return;
            }
            post([](Updater *u) { u->setState("downloading"); });
            manager->DownloadUpdates(*info, [](void *user, size_t percent) {
                auto *u = static_cast<Updater *>(user);
                QMetaObject::invokeMethod(qApp, [u, percent] { u->setState("downloading", int(percent)); }, Qt::QueuedConnection);
            }, self.data());
            const Velopack::VelopackAsset target = info->TargetFullRelease;
            post([target](Updater *u) {
                u->d->busy = false;
                u->d->pending = target;
                u->m_available = QString::fromStdString(target.Version);
                u->setState("ready", 100);
            });
        } catch (const std::exception &e) {
            const QString why = QString::fromUtf8(e.what());
            post([why](Updater *u) {
                u->d->busy = false;
                qWarning("message-hub: update check failed: %s", qPrintable(why));
                u->setState("error");
            });
        }
    });
    connect(t, &QThread::finished, t, &QObject::deleteLater);
    t->start();
#endif
}

bool Updater::applyAndExit(const QStringList &restartArgs) {
#ifdef MESSAGE_HUB_UPDATER
    if (!enabled() || !d->pending) return false;
    std::vector<std::string> args;
    for (const QString &a : restartArgs) args.push_back(a.toStdString());
    try {
        d->manager->WaitExitThenApplyUpdates(*d->pending, /*silent*/ true, /*restart*/ true, args);
    } catch (const std::exception &e) {
        qWarning("message-hub: could not start the update: %s", e.what());
        setState("error");
        return false;
    }
    // The updater waits for this process to end before it installs. If shutting down hangs (a network call or a worker
    // thread that won't finish), end the process anyway, or the update would wait for it indefinitely.
    std::thread([] {
        std::this_thread::sleep_for(std::chrono::seconds(3));
        std::_Exit(0);
    }).detach();
    QCoreApplication::exit(0);
    return true;
#else
    Q_UNUSED(restartArgs);
    return false;
#endif
}

void Updater::restartNow() { applyAndExit({}); }
