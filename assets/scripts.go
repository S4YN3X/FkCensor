package assets

import _ "embed"

//go:embed inject.js
var InjectJS []byte

//go:embed ui/index.html
var UIHTML []byte
