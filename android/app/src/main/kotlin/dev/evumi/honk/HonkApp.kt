package dev.evumi.honk

import android.app.Application

class HonkApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // A sync every six hours while the app is not running; KEEP leaves an existing schedule alone.
        SyncWorker.schedule(this)
        // Registers (or re-sends the token) on every start; an unchanged token costs no request.
        Thread { HonkService.get(this).registerWithCurrentToken() }.start()
    }
}
