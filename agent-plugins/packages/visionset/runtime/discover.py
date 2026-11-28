"""Find a `visionset` the bundle's compatibility range accepts.

Order: an explicit operator override, a user installation, a project installation, then the
plugin-owned cached runtime. The range is `compatibility` in `bundle.json`. A candidate is
only ever run, never modified.
"""
