
-- komórki przyporządkowane tabeli
select 
tvc.*,
cel.* EXCLUDE (ROWGUID, CELLID),
hedx.Direction "DirectionX",
hdvx."HeaderVID",

hdvx."Code" "CodeX",
hdvx."Label" "LabelX",
tvhx."Order" "OrderX",
-- tvhx."RowGUID" "RowGUIDX" --,
-- hedy.Direction "DirectionY",
hdvy."Code" "CodeY",
hdvy."Label" "LabelY",
tvhy."Order" "OrderY"
from "TableVersion" tbv
join "TableVersionCell" tvc on tvc."TableVID" = tbv."TableVID"
join "Cell" cel on cel."CellID" = tvc."CellID"
join "Header" hedx on hedx.HeaderID = cel.ColumnID and hedx.TableID = tbv.TableID
join "HeaderVersion" hdvx on hdvx."HeaderID" = hedx."HeaderID"
join "TableVersionHeader" tvhx on tvhx."HeaderVID" = hdvx."HeaderVID" and tvhx."TableVID" = tbv."TableVID" and tvhx."HeaderID" = hedx."HeaderID"
join "Header" hedy on hedy.HeaderID = cel.RowID and hedy.TableID = tbv.TableID
join "HeaderVersion" hdvy on hdvy."HeaderID" = hedy."HeaderID"
join "TableVersionHeader" tvhy on tvhy."HeaderVID" = hdvy."HeaderVID" and tvhy."TableVID" = tbv."TableVID" and tvhy."HeaderID" = hedy."HeaderID"

-- join "Header" hedz on hedy.HeaderID = cel.SheetID and hedz.TableID = tbv.TableID
where tbv.TableVID = 6588
and hdvx."EndReleaseID" is Null
and hdvy."EndReleaseID" is Null
order by cel.SheetId, tvhy."Order" , tvhx."Order" 