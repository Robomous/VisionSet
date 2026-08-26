"""Pre-processing drivers: the pixel side of a recipe, outside the kernel.

The kernel owns the geometry of every recipe step and takes a
:class:`~visionset.kernel.ports.PreprocessingDriver` *instance* per step kind;
it may not scan entry points, so discovery lives here, beside the built-in
Pillow drivers, the way ``visionset.formats`` sits beside its plugins.
"""
