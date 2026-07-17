# Afterglow Android development environment.
#
# Source this from a shell (or your ~/.bashrc / ~/.zshrc):
#   source scripts/android-env.sh
#
# It points JAVA_HOME at the JDK installed by scripts/setup-android-env.sh
# (falling back to whatever JAVA_HOME already was) and puts the Android SDK
# tools on PATH. Safe to source repeatedly.

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
# Kept for older tools that still read the deprecated name:
export ANDROID_SDK_ROOT="$ANDROID_HOME"

# Highest setup-managed JDK wins; otherwise leave JAVA_HOME alone.
_afterglow_jdk="$(ls -d "$HOME/Android/jdk"/jdk-* 2>/dev/null | sort -V | tail -n 1)"
if [ -n "$_afterglow_jdk" ]; then
  export JAVA_HOME="$_afterglow_jdk"
fi
unset _afterglow_jdk

case ":$PATH:" in
  *":$ANDROID_HOME/platform-tools:"*) ;;
  *)
    PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
    ;;
esac
if [ -n "$JAVA_HOME" ]; then
  case ":$PATH:" in
    *":$JAVA_HOME/bin:"*) ;;
    *) PATH="$JAVA_HOME/bin:$PATH" ;;
  esac
fi
export PATH
