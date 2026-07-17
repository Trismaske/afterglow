package expo.modules.materialyouaccent

import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Reads the Material You dynamic palette — android.R.color.system_accent1_
 * {200,500,700} — as #rrggbb strings. Returns null below Android 12
 * (the system_accent1_* resources exist only since API 31) or when no
 * context is available; the JS side treats null as "no dynamic palette".
 */
class MaterialYouAccentModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MaterialYouAccent")

    Function("getSystemAccents") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
        return@Function null
      }
      val context = appContext.reactContext ?: return@Function null
      fun hex(resId: Int): String =
        String.format("#%06x", context.getColor(resId) and 0xffffff)
      mapOf(
        "accent200" to hex(android.R.color.system_accent1_200),
        "accent500" to hex(android.R.color.system_accent1_500),
        "accent700" to hex(android.R.color.system_accent1_700),
      )
    }
  }
}
