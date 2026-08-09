with 
q_metric as 
(
select 
vav.VariableVID, 
itc."Code" as "Met_Code",
itm."Name" as "Met_Name"
from VariableVersion vav
join Property prp on prp.PropertyID = vav.PropertyID
join Item itm on itm.ItemID = vav.PropertyID
join ItemCategory itc on itc.ItemID = itm.ItemID
where 1=1
-- and vav.VariableVID = 3260072
and itc.EndReleaseID is Null
),
q_context as 
(
select 
coc.ContextID, 
cat."Code" AS "Category_Code", 
cat."Name" AS "Category_Name", 
itc."Code" AS "ItemCategory_Code",
itm."Name" As "ItemName",
itc."Signature" AS "ItemCategory_Signature"
from ContextComposition coc
join Item itm on itm.ItemID = coc.ItemID
join ItemCategory itc on itc.ItemID = itm.ItemID
join Category cat on cat.CategoryID = itc.CategoryID
where
1=1
-- and coc.ContextID = 937197
and itc.EndReleaseID is null 
)
select 
vav.VariableID,
vav.VariableVID,
qm."Met_Code",
qm."Met_Name",
qc."Category_Code",
qc."Category_Name",
qc."ItemCategory_Code",
qc."ItemName"
from VariableVersion vav
join q_metric qm on qm.VariableVID = vav.VariableVID
join q_context qc on qc.ContextID = vav.ContextID
where vav.VariableVID = 5478642
order by qc."Category_Code"