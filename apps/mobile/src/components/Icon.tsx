/**
 * THE icon (m0.9.1, Tristan's screenshot review 2026-10-09): every icon
 * in the app is a Material Community glyph, and a glyph is a font — it
 * scaled with the OS font size like text while its frame (the tab's
 * 36 dp circle, a chip's slot, a mark's disc) did not, so at 1.3 the
 * tab icon pressed its circle and at 2.0 it was clipped. The rule
 * (docs/STATE_MODEL.md, "Text scales; layouts stack"): only TEXT scales
 * with the font setting; icons keep their dp size, as Android's own do,
 * and the display-size setting is what scales them. This wrapper pins
 * `allowFontScaling` off; import it instead of the vector-icons set
 * (the walk's report flags a glyph that grew as ICON).
 */
import React from 'react';
import { MaterialCommunityIcons } from '@expo/vector-icons';

export type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

export function Icon(props: React.ComponentProps<typeof MaterialCommunityIcons>) {
  return <MaterialCommunityIcons allowFontScaling={false} {...props} />;
}
