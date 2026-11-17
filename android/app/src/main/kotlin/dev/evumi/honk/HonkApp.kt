package dev.evumi.honk

import android.app.Application

class HonkApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Registers (or re-sends the token) on every start; an unchanged token costs no request.
        Thread { HonkService.get(this).registerWithCurrentToken() }.start()
    }
}
