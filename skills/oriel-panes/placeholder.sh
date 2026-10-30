# Oriel's placeholder for a plugin pane: "$1" (the title) and "$2" (the address) centered, drawn again on a
# resize; keys do nothing. Usage: sh placeholder.sh Browser http://localhost:3000 (or File /repo/main.ts)
draw() {
  set -- $(stty size 2>/dev/null || echo "24 80"); r=$1 c=$2
  printf '\033[?25l\033[2J'
  line() {
    x=$(( (c - ${#2}) / 2 + 1 )); [ $x -lt 1 ] && x=1
    printf '\033[%d;%dH%b%s\033[0m' "$1" "$x" "$3" "$2"
  }
  y=$(( r / 2 - 2 ))
  line $y "$T" '\033[1m'
  [ -n "$U" ] && line $((y + 2)) "$U" '\033[4;34m'
  line $((y + 4)) "Shown in Oriel" '\033[2m'
}
T=$1 U=$2
stty raw -echo 2>/dev/null
trap draw WINCH
draw
cat <&0 >/dev/null &
while kill -0 $! 2>/dev/null; do wait $!; done
