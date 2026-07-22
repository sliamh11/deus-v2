# Third-party code

This repository's own license is MIT (see `LICENSE`). Some files under
`src/cli/tui-v2/` are ported, adapted, or directly copied from third-party
open-source projects under their own separate license terms. Each such file
carries a doc-comment citation naming its source; this file consolidates
that attribution in one place.

## google-gemini/gemini-cli

- **Source**: https://github.com/google-gemini/gemini-cli
- **License**: Apache License 2.0
  (https://github.com/google-gemini/gemini-cli/blob/main/LICENSE)
- **Copyright**: Google LLC
- **Scope**: `src/cli/tui-v2/` — the terminal UI layer (theming, syntax
  highlighting, diff rendering, tool-call visualization, App shell, command
  framework skeleton) was forked from `packages/cli/src/ui/` and adapted to
  Deus's own client/server protocol (LIA-473). Files near-verbatim ported
  retain the donor's logic with import paths and Deus-specific types
  adapted; files where Gemini's own logic was fundamentally incompatible
  with Deus's server-side tool-execution architecture (see LIA-473's design
  decisions) use Gemini's visual/interaction patterns as a reference only,
  with entirely new, Deus-native logic underneath. Each ported/adapted file
  states which category it falls into in its own header comment.
- gemini-cli's own repository has no `NOTICE` file to propagate (checked at
  time of vendoring).

Apache License 2.0 in full:

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
