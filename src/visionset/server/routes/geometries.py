# usage: from visionset.server.routes import geometries
"""Which geometries an annotation can carry on this server.

A listing rather than a line in the documentation, so a client offering shapes
to draw reads them from the one place they are decided: ``IMPLEMENTED_GEOMETRIES``,
read off the ``Geometry`` union. ``GeometryType`` names more than that — the
members with no model yet are refused when a class declares one — and a client
that offered the whole enum would offer classes nobody could annotate.

Not nested under a project: the set is a property of this build, the same for
every schema. Order and wording are the client's; the listing is sorted by name
only so the wire shape is stable.

Handlers are ``def``, not ``async def``, for the reason ``projects.py`` gives.
"""

from __future__ import annotations

from visionset.kernel.domain import IMPLEMENTED_GEOMETRIES
from visionset.server.dependencies import protected_router
from visionset.server.models import GeometryOut, GeometryPage

router = protected_router(prefix="/geometries", tags=["schemas"])


@router.get("")
def list_geometries() -> GeometryPage:
    """Every geometry an annotation can carry on this server, by name.

    `name` is a value `LabelClassBody.geometries` accepts. A schema whose class
    names a geometry outside this list is refused when it is saved, so this is
    the set a schema editor offers.
    """
    rows = [GeometryOut(name=geometry) for geometry in sorted(IMPLEMENTED_GEOMETRIES)]
    return GeometryPage(items=rows, total=len(rows))
