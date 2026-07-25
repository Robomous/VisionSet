"""Importer/exporter plugin system.

Plugins implement the ``Importer``/``Exporter`` ports from
``visionset.kernel.ports`` and are discovered through the entry-point group
``visionset.formats`` — third-party distributions (e.g. ``visionset-format-x``)
register in the same group and plug in identically to the built-ins.
"""
